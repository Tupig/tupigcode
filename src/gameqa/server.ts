/**
 * gameqa/server.ts — 编排服务 HTTP 层（server/main.go 移植）
 * API 与 Python v1 / Go v2 完全对齐（前端看板 static/ 无需改动）。
 * 中间件顺序与 Go 版一致：requestLogger(recoverer(tokenAuth(mux)))。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Store, type Json, type Job, type Agent } from "./store.js";
import { SKILLS } from "./skills.js";
import { mcpGet, mcpPost, mcpAvailable, mcpMergeProps, TOOL_NAME_RE } from "./mcp.js";
import { generateTestCase } from "./openai.js";
import { renderReportHtml } from "./report.js";
import { renderAllureHtml } from "./allure.js";
import { notifyJobFailure } from "./notify.js";

export const VERSION = process.env["GAMEQA_VERSION"] ?? "1.0.0";
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  segs: string[];
  handler: Handler;
}

// ---------- 响应 / 请求工具 ----------

function writeJSON(res: http.ServerResponse, status: number, v: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status);
  res.end(JSON.stringify(v) + "\n");
}

function writeRawJSON(res: http.ServerResponse, status: number, body: string): void {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status);
  res.end(body);
}

/** FastAPI 兼容错误格式 */
function writeDetail(res: http.ServerResponse, status: number, detail: string): void {
  writeJSON(res, status, { detail });
}

/** 丢弃剩余请求体（有界 8MB）：拟 Go 自动 drain，读完才能安全响应否则客户端 EPIPE */
async function drainBody(req: http.IncomingMessage): Promise<boolean> {
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES * 8) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function decodeBody<T>(ctx: Ctx): Promise<T | null> {
  const ct = (ctx.req.headers["content-type"] ?? "").trim();
  if (ct !== "" && !ct.startsWith("application/json")) {
    if (!(await drainBody(ctx.req))) ctx.res.setHeader("Connection", "close");
    writeDetail(ctx.res, 415, "Content-Type 必须为 application/json");
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // 超限不 break（break 会 destroy 请求流，客户端续写即 EPIPE）：标记后继续丢弃到 EOF（有界 8MB）
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (tooLarge) {
      if (size > MAX_BODY_BYTES * 8) {
        ctx.res.setHeader("Connection", "close");
        writeDetail(ctx.res, 413, "请求体超过 1MB 限制");
        return null;
      }
      continue;
    }
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    writeDetail(ctx.res, 413, "请求体超过 1MB 限制");
    return null;
  }
  try {
    const text = Buffer.concat(chunks).toString("utf-8");
    return JSON.parse(text === "" ? "{}" : text) as T;
  } catch (err) {
    writeDetail(ctx.res, 400, `请求体解析失败: ${(err as Error).message}`);
    return null;
  }
}

function tokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------- 路由 ----------

function compile(pattern: string): string[] {
  return pattern.split("/").filter((s) => s !== "");
}

class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segs: compile(pattern), handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = compile(pathname);
    let best: { handler: Handler; params: Record<string, string> } | null = null;
    let bestWild = Infinity;
    for (const r of this.routes) {
      if (r.method !== method || r.segs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let wild = 0;
      let ok = true;
      for (let i = 0; i < r.segs.length; i++) {
        const p = r.segs[i];
        if (p.startsWith("{") && p.endsWith("}")) {
          params[p.slice(1, -1)] = decodeURIComponent(segs[i]);
          wild++;
        } else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      // 通配段少者优先（字面路由不被 {id} 抢占，等价 Go ServeMux 具体度选择）
      if (ok && wild < bestWild) {
        best = { handler: r.handler, params };
        bestWild = wild;
      }
    }
    return best;
  }
}

// ---------- 静态资源 ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** 静态文件服务：目录一律 404（noDirFS），路径穿越防护，no-cache */
function serveStatic(staticDir: string, urlPath: string, res: http.ServerResponse): void {
  const rel = urlPath.replace(/^\/static\/?/, "");
  const abs = path.resolve(staticDir, rel);
  if (!abs.startsWith(path.resolve(staticDir) + path.sep) && abs !== path.resolve(staticDir)) {
    writeDetail(res, 404, "not found");
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    writeDetail(res, 404, "not found");
    return;
  }
  if (st.isDirectory()) {
    writeDetail(res, 404, "not found");
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.writeHead(200);
  res.end(fs.readFileSync(abs));
}

// ---------- 构建 handler ----------

function buildRoutes(store: Store, staticDir: string): Router {
  const r = new Router();
  const nowFloat = (): number => Date.now() / 1000;

  r.add("GET", "/api/health", ({ res }) => {
    try {
      store.healthCheck();
      writeJSON(res, 200, { ok: true, version: VERSION });
    } catch (err) {
      writeJSON(res, 503, { ok: false, version: VERSION, error: (err as Error).message });
    }
  });

  r.add("GET", "/api/version", ({ res }) => writeJSON(res, 200, { version: VERSION }));

  r.add("GET", "/api/skills", ({ res }) => writeJSON(res, 200, { items: SKILLS, total: SKILLS.length }));

  // ---------- Agent ----------

  r.add("POST", "/api/agents/register", async (ctx) => {
    const body = await decodeBody<{ agent_id?: string; platform?: string; skills?: string[]; extra?: Record<string, Json> }>(ctx);
    if (!body) return;
    const skills = body.skills ?? [];
    const extra = body.extra ?? {};
    const agentId = body.agent_id ?? "";
    store.setAgent(agentId, {
      agent_id: agentId,
      platform: body.platform ?? null,
      skills,
      extra,
      last_seen: nowFloat(),
      status: "idle",
      current_job_id: null,
    } as Agent);
    writeJSON(ctx.res, 200, { ok: true, agent_id: agentId });
  });

  r.add("POST", "/api/agents/heartbeat", async (ctx) => {
    const body = await decodeBody<{ agent_id?: string; status?: string; current_job_id?: number | null }>(ctx);
    if (!body) return;
    if (!store.heartbeat(body.agent_id ?? "", body.status ?? "idle", body.current_job_id ?? null, nowFloat())) {
      writeDetail(ctx.res, 404, "agent not registered");
      return;
    }
    writeJSON(ctx.res, 200, { ok: true });
  });

  r.add("GET", "/api/agents", ({ res }) => writeJSON(res, 200, store.listAgents()));

  // ---------- 任务 ----------

  r.add("POST", "/api/jobs", async (ctx) => {
    const body = await decodeBody<{
      platform?: string;
      required_skills?: string[];
      unity_project_path?: string | null;
      test_filter?: string | null;
      extra?: Record<string, Json>;
    }>(ctx);
    if (!body) return;
    const extra: Record<string, Json> = { ...(body.extra ?? {}) };
    // GPT 生成并执行：先调用模型生成 C# 测试代码写入 extra（与 Python/Go 版一致）
    if (extra["job_type"] === "generate_and_run" && typeof extra["prompt"] === "string" && extra["prompt"] !== "") {
      const assembly = typeof extra["unity_assembly"] === "string" ? (extra["unity_assembly"] as string) : "";
      const [code, errStr] = await generateTestCase(extra["prompt"] as string, assembly);
      if (code !== "") extra["generated_test_csharp"] = code;
      if (errStr !== "") extra["generate_error"] = errStr;
    }
    const jid = store.nextJobId();
    const job: Job = {
      job_id: jid,
      platform: body.platform ?? null,
      required_skills: body.required_skills ?? [],
      unity_project_path: body.unity_project_path ?? null,
      test_filter: body.test_filter ?? null,
      extra,
      status: "pending",
      created_at: nowFloat(),
      result: null,
    };
    store.appendJob(job);
    writeJSON(ctx.res, 200, { ok: true, job_id: jid });
  });

  r.add("GET", "/api/jobs", ({ res }) => writeJSON(res, 200, store.listJobs()));

  r.add("GET", "/api/jobs/{id}", (ctx) => {
    const id = parseInt(ctx.params["id"] ?? "", 10);
    if (Number.isNaN(id)) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    const job = store.findJob(id);
    if (!job) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    writeJSON(ctx.res, 200, job);
  });

  r.add("POST", "/api/jobs/result", async (ctx) => {
    const body = await decodeBody<{ job_id?: number; agent_id?: string; success?: boolean; log_path?: string | null; summary?: Record<string, Json> }>(ctx);
    if (!body) return;
    const agentId = body.agent_id ?? "";
    // 安全增强：结果只能由已注册 Agent 上报（防匿名伪造）
    if (!store.hasAgent(agentId)) {
      writeDetail(ctx.res, 403, "agent not registered");
      return;
    }
    const jobId = typeof body.job_id === "number" ? body.job_id : 0;
    if (!store.hasJob(jobId)) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    if (!store.agentOwnsJob(agentId, jobId)) {
      writeDetail(ctx.res, 403, "agent does not own job");
      return;
    }
    if (!store.setJobResult(jobId, agentId, body.success === true, body.log_path ?? null, body.summary ?? {})) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    if (body.success !== true) {
      notifyJobFailure({ job_id: jobId, platform: "unknown" }, agentId, body.summary ?? {});
    }
    writeJSON(ctx.res, 200, { ok: true });
  });

  r.add("POST", "/api/jobs/cleanup", ({ res }) => writeJSON(res, 200, { ok: true, removed: store.cleanupJobs() }));

  r.add("POST", "/api/jobs/{id}/cancel", (ctx) => {
    const id = parseInt(ctx.params["id"] ?? "", 10);
    if (Number.isNaN(id)) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    const [found, cancelled] = store.cancelJob(id);
    if (!found) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    if (!cancelled) {
      writeDetail(ctx.res, 409, "任务已通过/失败，不可取消");
      return;
    }
    writeJSON(ctx.res, 200, { ok: true, status: "cancelled" });
  });

  r.add("DELETE", "/api/jobs/{id}", (ctx) => {
    const id = parseInt(ctx.params["id"] ?? "", 10);
    if (Number.isNaN(id) || !store.deleteJob(id)) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    writeJSON(ctx.res, 200, { ok: true });
  });

  r.add("POST", "/api/jobs/artifacts", async (ctx) => {
    const body = await decodeBody<{ job_id?: number; agent_id?: string; files?: { name?: string; content?: string }[] }>(ctx);
    if (!body) return;
    if (!store.hasAgent(body.agent_id ?? "")) {
      writeDetail(ctx.res, 403, "agent not registered");
      return;
    }
    const jobId = typeof body.job_id === "number" ? body.job_id : 0;
    if (!store.hasJob(jobId)) {
      writeDetail(ctx.res, 404, "job not found");
      return;
    }
    if (!store.agentOwnsJob(body.agent_id ?? "", jobId)) {
      writeDetail(ctx.res, 403, "agent does not own job");
      return;
    }
    const files = body.files ?? [];
    if (files.length > 10) {
      writeDetail(ctx.res, 400, "单次最多上传 10 个文件");
      return;
    }
    let stored = 0;
    for (const f of files) {
      try {
        store.saveArtifact(jobId, f.name ?? "", Buffer.from(f.content ?? "", "utf-8"));
      } catch (err) {
        writeDetail(ctx.res, 400, (err as Error).message);
        return;
      }
      stored++;
    }
    writeJSON(ctx.res, 200, { ok: true, stored });
  });

  r.add("GET", "/api/jobs/artifacts", (ctx) => {
    const id = parseInt(ctx.query.get("job_id") ?? "", 10);
    if (Number.isNaN(id)) {
      writeDetail(ctx.res, 400, "job_id 必须为整数");
      return;
    }
    writeJSON(ctx.res, 200, { job_id: id, files: store.listArtifacts(id) });
  });

  r.add("GET", "/api/jobs/artifacts/{name}", (ctx) => {
    const id = parseInt(ctx.query.get("job_id") ?? "", 10);
    if (Number.isNaN(id)) {
      writeDetail(ctx.res, 400, "job_id 必须为整数");
      return;
    }
    const name = ctx.params["name"] ?? "";
    let data: Buffer;
    try {
      data = store.readArtifact(id, name);
    } catch {
      writeDetail(ctx.res, 404, "artifact not found");
      return;
    }
    ctx.res.setHeader("Content-Type", name.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
    ctx.res.writeHead(200);
    ctx.res.end(data);
  });

  r.add("GET", "/api/jobs/poll/{platform}", (ctx) => {
    const platform = ctx.params["platform"] ?? "";
    const skills = new Set<string>();
    for (const sk of (ctx.query.get("skills") ?? "").split(",")) {
      const t = sk.trim();
      if (t !== "") skills.add(t);
    }
    const job = store.pollJob(platform, skills);
    writeRawJSON(ctx.res, 200, job ? `{"job": ${JSON.stringify(job)}}\n` : `{"job": null}\n`);
  });

  // ---------- GPT 生成测试 ----------

  r.add("POST", "/api/generate-test", async (ctx) => {
    const body = await decodeBody<{ prompt?: string; assembly?: string }>(ctx);
    if (!body) return;
    const [code, errStr] = await generateTestCase(body.prompt ?? "", body.assembly ?? "");
    // 与 Python 版一致：空值返回 null
    writeJSON(ctx.res, 200, { code: code !== "" ? code : null, error: errStr !== "" ? errStr : null });
  });

  // ---------- Unity MCP 代理 ----------

  r.add("GET", "/api/mcp/status", async ({ res }) => {
    const available = await mcpAvailable();
    const instances: Record<string, Json> = available ? await mcpGet("/resources/unity_instances", null, 30_000) : {};
    writeJSON(res, 200, { available, instances });
  });

  r.add("POST", "/api/mcp/execute-tool", async (ctx) => {
    const body = await decodeBody<{ tool_name?: string; tool_params?: Record<string, Json> }>(ctx);
    if (!body) return;
    const toolName = body.tool_name ?? "";
    if (toolName === "") {
      writeDetail(ctx.res, 400, "tool_name 是必需的");
      return;
    }
    if (!TOOL_NAME_RE.test(toolName)) {
      writeDetail(ctx.res, 400, "tool_name 仅允许字母、数字、下划线与连字符");
      return;
    }
    writeJSON(ctx.res, 200, await mcpPost("/tools/" + toolName, body.tool_params ?? {}, 30_000));
  });

  r.add("POST", "/api/mcp/batch-execute", async (ctx) => {
    const body = await decodeBody<{ tools?: Json }>(ctx);
    if (!body) return;
    // 与 Python 版一致：缺 tools 键按空列表执行；存在但非列表才报错
    if (!("tools" in (body as Record<string, Json>))) {
      writeJSON(ctx.res, 200, await mcpPost("/tools/batch_execute", { tools: [] }, 30_000));
      return;
    }
    if (body.tools !== null && !Array.isArray(body.tools)) {
      writeDetail(ctx.res, 400, "tools 必须是列表");
      return;
    }
    writeJSON(ctx.res, 200, await mcpPost("/tools/batch_execute", { tools: body.tools ?? [] }, 30_000));
  });

  r.add("POST", "/api/mcp/set-active-instance", async (ctx) => {
    const body = await decodeBody<{ instance_id?: string }>(ctx);
    if (!body) return;
    if (!body.instance_id) {
      writeDetail(ctx.res, 400, "instance_id 是必需的");
      return;
    }
    writeJSON(ctx.res, 200, await mcpPost("/tools/set_active_instance", { instance_id: body.instance_id }, 30_000));
  });

  const manageGeneric = (actionKey: string, pathKey: string, errMsg: string, endpoint: string): Handler => {
    return async (ctx) => {
      const body = await decodeBody<Record<string, Json>>(ctx);
      if (!body) return;
      const action = body[actionKey];
      const pathVal = body[pathKey];
      if (typeof action !== "string" || action === "" || typeof pathVal !== "string" || pathVal === "") {
        writeDetail(ctx.res, 400, errMsg);
        return;
      }
      const props = body["properties"];
      const merged = mcpMergeProps(
        { [actionKey]: action, [pathKey]: pathVal },
        props && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, Json>) : null,
      );
      writeJSON(ctx.res, 200, await mcpPost(endpoint, merged, 30_000));
    };
  };

  r.add("POST", "/api/mcp/manage-scene", manageGeneric("action", "scene_path", "action 和 scene_path 是必需的", "/tools/manage_scene"));
  r.add("POST", "/api/mcp/manage-asset", manageGeneric("action", "asset_path", "action 和 asset_path 是必需的", "/tools/manage_asset"));
  r.add("POST", "/api/mcp/manage-material", manageGeneric("action", "material_path", "action 和 material_path 是必需的", "/tools/manage_material"));

  r.add("POST", "/api/mcp/execute-menu-item", async (ctx) => {
    const body = await decodeBody<{ menu_path?: string }>(ctx);
    if (!body) return;
    if (!body.menu_path) {
      writeDetail(ctx.res, 400, "menu_path 是必需的");
      return;
    }
    writeJSON(ctx.res, 200, await mcpPost("/tools/execute_menu_item", { menu_path: body.menu_path }, 30_000));
  });

  r.add("GET", "/api/mcp/project-info", async ({ res }) => writeJSON(res, 200, await mcpGet("/resources/project_info", new URLSearchParams(), 30_000)));

  r.add("GET", "/api/mcp/scene-info", async ({ res }) => writeJSON(res, 200, await mcpGet("/resources/scene_info", new URLSearchParams(), 30_000)));

  // ---------- 看板 ----------

  r.add("GET", "/report", ({ res }) => {
    const html = renderReportHtml(store.listJobs().items);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  r.add("GET", "/allure", ({ res, query }) => {
    const jobRaw = parseInt(query.get("job") ?? "", 10);
    const html = renderAllureHtml(store.listJobs().items, Number.isNaN(jobRaw) ? undefined : jobRaw);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  r.add("GET", "/", ({ res }) => {
    const idx = path.join(staticDir, "index.html");
    if (!fs.existsSync(idx)) {
      writeDetail(res, 404, "index.html not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.writeHead(200);
    res.end(fs.readFileSync(idx));
  });

  return r;
}

// ---------- 入口 ----------

export function createGameqaServer(store: Store, staticDir: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const router = buildRoutes(store, staticDir);

  return (req, res) => {
    const start = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    res.on("finish", () => {
      console.log(`[HTTP] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - start}ms`);
    });

    const proceed = async (): Promise<void> => {
      // recoverer：未捕获异常 → 500（而非裸断连）
      try {
        const hit = router.match(req.method ?? "GET", pathname);
        if (hit) {
          await hit.handler({ req, res, params: hit.params, query: url.searchParams });
          return;
        }
        if (req.method === "GET" && pathname.startsWith("/static/")) {
          serveStatic(staticDir, pathname, res);
          return;
        }
        writeDetail(res, 404, "Not Found");
      } catch (err) {
        console.error(`[PANIC] ${req.method} ${pathname}:`, err);
        if (!res.headersSent) writeDetail(res, 500, "internal server error");
        else res.end();
      }
    };

    // tokenAuth：PLATFORM_TOKEN 设置后，/api/*（除 health/version）与报告页需要 token（fix #117）
    const token = process.env["PLATFORM_TOKEN"] ?? "";
    if (token !== "") {
      const isApi =
        pathname.startsWith("/api/") && pathname !== "/api/health" && pathname !== "/api/version";
      const isReportPage = pathname === "/report" || pathname === "/allure";
      if (isApi || isReportPage) {
        let got = (req.headers["x-platform-token"] as string | undefined) ?? "";
        if (got === "" && isReportPage) {
          got = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
        }
        if (!tokenEqual(got, token)) {
          writeDetail(res, 401, "unauthorized: missing or invalid X-Platform-Token");
          return;
        }
      }
    }
    void proceed();
  };
}
