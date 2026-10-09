/**
 * gameqa/agent.ts — 测试 Agent（Rust agent/src 与 runner_* 占位逻辑的 TS 落地）
 * 循环：心跳 → 拉取任务（skills 匹配）→ 执行 → 上报（3 重试）→ 上传产物。
 * 环境变量与 Python/Rust 版一致：PLATFORM_URL、AGENT_ID、PLATFORM、AGENT_SKILLS、AGENT_WORKDIR、
 * PLATFORM_INSECURE_TLS / PLATFORM_TLS_CERT（自签名服务端信任）、MCP_SERVER_URL。
 *
 * 执行分发：
 *   （无 job_type）        → Unity batchmode 真实执行（蓝本占位的正式实现）
 *   generate_and_run      → generated_test_csharp 写入项目后执行 + 默认清理
 *   use_mcp               → 直连 Unity MCP run_tests
 *   self_check            → Agent 本地环境自检
 *   airtest / ai_exploratory / game_perf / unity_log_scan / device_inventory → 见 executors/
 */
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Json, Job } from "./store.js";
import { runUnityTests, parseNUnitXml, tailUtf8, ARTIFACT_MAX_BYTES } from "./unity.js";
import { mcpPost } from "./mcp.js";
import { executeAgentJobType, type Outcome } from "./executors.js";

const POLL_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

function envOr(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

export function skillsFromEnv(): string[] {
  return (process.env["AGENT_SKILLS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function randomAgentId(): string {
  const nanos = Number(process.hrtime.bigint() % 0xffff_ffffn);
  return ((nanos ^ process.pid) >>> 0).toString(16).padStart(8, "0");
}

// ---------- 平台客户端 ----------

interface HttpJson {
  status: number;
  json: Record<string, Json>;
}

export class PlatformClient {
  private baseUrl: string;
  private ca?: Buffer;

  constructor(baseUrl: string, private agentId: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const caFile = (process.env["PLATFORM_TLS_CERT"] ?? "").trim();
    if (caFile !== "" && fs.existsSync(caFile)) this.ca = fs.readFileSync(caFile);
  }

  private request(method: string, p: string, body?: unknown): Promise<HttpJson> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(this.baseUrl + p);
      } catch (err) {
        reject(err);
        return;
      }
      const isHttps = u.protocol === "https:";
      const insecure = isHttps && process.env["PLATFORM_INSECURE_TLS"] === "1" && !this.ca;
      const mod = isHttps ? https : http;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
      const req = mod.request(
        u,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": String(payload.length) } : {}),
          },
          rejectUnauthorized: !insecure,
          ...(this.ca ? { ca: this.ca } : {}),
          timeout: 30_000,
        },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c: Buffer) => chunks.push(c));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            let json: Record<string, Json> = {};
            try {
              json = JSON.parse(text) as Record<string, Json>;
            } catch {
              json = { raw: text };
            }
            resolve({ status: resp.statusCode ?? 0, json });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  async register(platform: string, skills: string[]): Promise<void> {
    const r = await this.request("POST", "/api/agents/register", { agent_id: this.agentId, platform, skills, extra: {} });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  }

  async heartbeat(status: "idle" | "running", currentJobId: number | null): Promise<void> {
    await this.request("POST", "/api/agents/heartbeat", { agent_id: this.agentId, status, current_job_id: currentJobId });
  }

  async poll(platform: string, skills: string[]): Promise<Job | null> {
    const r = await this.request("GET", `/api/jobs/poll/${encodeURIComponent(platform)}?skills=${encodeURIComponent(skills.join(","))}`);
    if (r.status !== 200) throw new Error(`poll HTTP ${r.status}`);
    const job = r.json["job"];
    return job !== null && typeof job === "object" && !Array.isArray(job) ? (job as Job) : null;
  }

  async submitResult(jobId: number, success: boolean, logPath: string | null, summary: Record<string, Json>): Promise<void> {
    const r = await this.request("POST", "/api/jobs/result", { job_id: jobId, agent_id: this.agentId, success, log_path: logPath, summary });
    if (r.status !== 200) throw new Error(`result HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  }

  async uploadArtifacts(jobId: number, files: [string, string][]): Promise<void> {
    if (files.length === 0) return;
    const r = await this.request("POST", "/api/jobs/artifacts", {
      job_id: jobId,
      agent_id: this.agentId,
      files: files.map(([name, content]) => ({ name, content })),
    });
    if (r.status !== 200) throw new Error(`artifacts HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  }
}

// ---------- 执行 ----------

function extraOf(job: Job): Record<string, Json> {
  const e = job["extra"];
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, Json>) : {};
}

function str(v: Json | undefined): string {
  return typeof v === "string" ? v : "";
}

/** Unity 测试任务真实执行（runner_* run_unity_test 占位的正式实现） */
async function runUnityTestJob(job: Job, workdir: string): Promise<Outcome> {
  const extra = extraOf(job);
  const jobId = typeof job["job_id"] === "number" ? job["job_id"] : 0;
  fs.mkdirSync(workdir, { recursive: true });

  // MCP 模式：直连 Unity MCP 执行测试（runner_common.execute_mcp_tool 对齐）
  if (extra["use_mcp"] === true) {
    const testFilter = str(extra["test_filter"]);
    const result = await mcpPost("/tools/run_tests", { test_filter: testFilter }, 120_000);
    const hasErr = "error" in result;
    return {
      success: !hasErr,
      logPath: null,
      summary: hasErr
        ? { message: "MCP 执行出错", error: result["error"], test_filter: testFilter }
        : { message: "MCP 测试运行", result, test_filter: testFilter },
      artifacts: [],
    };
  }

  const projectPath = str(job["unity_project_path"]) || str(extra["unity_project_path"]);
  if (projectPath.trim() === "") {
    return { success: false, logPath: null, summary: { message: "缺少 unity_project_path" }, artifacts: [] };
  }

  // generate_and_run：生成的 C# 测试写入项目（默认执行后清理，extra.keep_generated 保留）
  const generated = str(extra["generated_test_csharp"]);
  const scriptSource = str(extra["test_script_path"]);
  let generatedFile: string | null = null;
  const keepGenerated = extra["keep_generated"] === true;
  const wantGenerate = generated !== "" || scriptSource !== "";
  if (wantGenerate) {
    let code = generated;
    if (code === "" && scriptSource !== "") {
      try {
        code = fs.readFileSync(scriptSource, "utf-8");
      } catch (err) {
        return { success: false, logPath: null, summary: { message: `读取 test_script_path 失败: ${(err as Error).message}` }, artifacts: [] };
      }
    }
    const genDir = path.join(projectPath, "Assets", "Tests", "Generated");
    fs.mkdirSync(genDir, { recursive: true });
    generatedFile = path.join(genDir, `Generated_${jobId}.cs`);
    fs.writeFileSync(generatedFile, code, "utf-8");
  }

  const testPlatform = str(extra["test_platform"]) || "PlayMode";
  const testFilter = str(extra["test_filter"]) || str(job["test_filter"]) || (wantGenerate ? "Generated" : "");
  const timeoutMin = typeof extra["timeout_minutes"] === "number" && extra["timeout_minutes"] > 0 ? (extra["timeout_minutes"] as number) : 30;
  const resultsPath = path.join(workdir, "results.xml");
  const logPath = path.join(workdir, "unity.log");

  try {
    const run = await runUnityTests({ projectPath, testPlatform, testFilter, resultsPath, logPath, timeoutMs: timeoutMin * 60_000 });

    const artifacts: [string, string][] = [];
    const pushTail = (name: string, p: string): void => {
      try {
        artifacts.push([name, tailUtf8(fs.readFileSync(p), ARTIFACT_MAX_BYTES)]);
      } catch {
        /* 文件不存在 */
      }
    };

    if (run.timedOut) {
      pushTail("unity.log", logPath);
      pushTail("results.xml", resultsPath);
      return { success: false, logPath, summary: { message: `Unity 执行超时（${timeoutMin} 分钟），已强制终止`, test_platform: testPlatform }, artifacts };
    }
    if (run.error !== undefined) {
      pushTail("unity.log", logPath);
      return { success: false, logPath, summary: { message: `Unity 启动失败: ${run.error}`, hint: "确认已安装 Unity 并设置 UNITY_PATH", test_platform: testPlatform }, artifacts };
    }

    pushTail("unity.log", logPath);
    pushTail("results.xml", resultsPath);

    const parsed = run.resultsXml !== "" ? parseNUnitXml(run.resultsXml) : null;
    if (run.exitCode === 0 && parsed) {
      return {
        success: true,
        logPath,
        summary: {
          message: `测试通过 ${parsed.passed}/${parsed.total}`,
          test_platform: testPlatform,
          total: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          cases: parsed.cases,
        },
        artifacts,
      };
    }
    if (parsed && parsed.failed > 0) {
      return {
        success: false,
        logPath,
        summary: {
          message: `测试失败 ${parsed.failed}/${parsed.total}`,
          test_platform: testPlatform,
          total: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          failures: parsed.failures.map((f) => ({ name: f.name, message: f.message })),
          cases: parsed.cases,
        },
        artifacts,
      };
    }
    return {
      success: false,
      logPath,
      summary: {
        message: `Unity 退出码 ${String(run.exitCode)}（测试结果无法解析，可能是编译失败，详见日志）`,
        test_platform: testPlatform,
        exit_code: run.exitCode,
      },
      artifacts,
    };
  } finally {
    if (generatedFile && !keepGenerated) {
      try {
        fs.rmSync(generatedFile, { force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }
}

/** 任务执行入口：按 job_type 分发 */
export async function execute(job: Job, workdir: string): Promise<Outcome> {
  const extra = extraOf(job);
  const jt = str(extra["job_type"]);

  if (jt === "" || jt === "generate_and_run") {
    return runUnityTestJob(job, workdir);
  }
  if (jt === "self_check") {
    return {
      success: true,
      logPath: null,
      summary: {
        message: "Agent 环境自检通过",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        workdir_writable: true,
      },
      artifacts: [],
    };
  }
  const custom = await executeAgentJobType(jt, job, workdir);
  if (custom !== null) return custom;
  // 与 Rust 版一致：未命中 job_type 走占位（success=true）
  return { success: true, logPath: null, summary: { message: "占位运行（未接真实执行器）" }, artifacts: [] };
}

// ---------- 主循环 ----------

export interface AgentOptions {
  platform?: string;
  baseUrl?: string;
  agentId?: string;
  workRoot?: string;
  /** 单次循环后退出（测试用）；默认无限循环 */
  maxIterations?: number;
  /** 空轮询间隔（测试用），默认 15s */
  pollIntervalMs?: number;
}

export async function runAgent(opts: AgentOptions = {}): Promise<void> {
  const platform = opts.platform ?? envOr("PLATFORM", "mac");
  const baseUrl = opts.baseUrl ?? envOr("PLATFORM_URL", "http://localhost:9111");
  const agentId = opts.agentId ?? process.env["AGENT_ID"] ?? randomAgentId();
  const skills = skillsFromEnv();
  const workRoot = opts.workRoot ?? envOr("AGENT_WORKDIR", "data/agent_runs");
  const pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const client = new PlatformClient(baseUrl, agentId);
  await client.register(platform, skills);
  console.log(`[Agent] 已注册 agent_id=${agentId} platform=${platform} skills=${JSON.stringify(skills)}`);

  let backoff = pollInterval;
  let iteration = 0;
  for (;;) {
    if (opts.maxIterations !== undefined && iteration >= opts.maxIterations) return;
    iteration++;
    try {
      await client.heartbeat("idle", null);
      const job = await client.poll(platform, skills);
      if (job === null) {
        backoff = pollInterval;
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }
      const jobId = typeof job["job_id"] === "number" ? job["job_id"] : 0;
      if (jobId === 0) {
        console.error("[Agent] 任务缺少合法 job_id，跳过执行");
        continue;
      }
      backoff = pollInterval;
      console.log(`[Agent] 领取任务 job_id=${jobId}`);
      await client.heartbeat("running", jobId);
      const workdir = path.join(workRoot, `job_${jobId}`);
      const outcome = await execute(job, workdir);
      console.log(`[Agent] 任务结果: ${JSON.stringify(outcome.summary)}`);
      // 上报失败重试 3 次：poll 只认 pending，一次丢失任务将永久卡在 running
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await client.submitResult(jobId, outcome.success, outcome.logPath, outcome.summary);
          break;
        } catch (err) {
          if (attempt < 3) {
            console.error(`[Agent] 结果上报失败（第 ${attempt} 次）:`, err);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            console.error("[Agent] 结果上报失败（已重试 3 次）:", err);
          }
        }
      }
      try {
        await client.uploadArtifacts(jobId, outcome.artifacts);
      } catch (err) {
        console.error("[Agent] 执行记录上传失败:", err);
      }
      await client.heartbeat("idle", null);
    } catch (err) {
      console.error(`[Agent] 错误: ${err}（${Math.round(backoff / 1000)}s 后重试）`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}
