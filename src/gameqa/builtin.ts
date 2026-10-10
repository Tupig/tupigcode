/**
 * gameqa/builtin.ts — 内置测试执行器族 + worker（builtin.go/webcheck.go/diagnostics.go/selfcheck.go 移植）
 * 无需 Agent，服务端直接执行：
 *   web_check 网站可用性 / api_check 接口测试 / api_load 性能冒烟 / api_flow 关键字流程 /
 *   self_check 环境自检 / port_check TCP 端口 / cert_check 证书到期 / dns_check DNS 断言
 * repeat_minutes > 0 时任务完成后自动排下一次（Uptime Kuma 监控模式）。
 */
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store, type Json, type Job } from "./store.js";
import { SKILLS } from "./skills.js";
import { VERSION } from "./server.js";
import { notifyJobFailure } from "./notify.js";

export const BUILTIN_WEB_AGENT_ID = "builtin-web";

function nowFloat(): number {
  return Date.now() / 1000;
}

function extraOf(job: Job): Record<string, Json> {
  const e = job["extra"];
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, Json>) : {};
}

/** 数值兼容读取：>0 生效否则默认值（numFromAny） */
function num(extra: Record<string, Json>, key: string, def: number): number {
  const v = extra[key];
  if (typeof v === "number" && v > 0) return v;
  return def;
}

function str(extra: Record<string, Json>, key: string): string {
  const v = extra[key];
  return typeof v === "string" ? v : "";
}

function bool(extra: Record<string, Json>, key: string, def: boolean): boolean {
  const v = extra[key];
  return typeof v === "boolean" ? v : def;
}

// ---------- 共享请求工具 ----------

interface HttpResult {
  statusCode: number;
  latencyMs: number;
  body: string;
}

/**
 * SSRF 防护（fix #118）：默认拒绝私网/环回/link-local/非 http(s)。
 * 本地联调或受信内网目标显式 GAMEQA_ALLOW_PRIVATE=1 放开。
 */
export function isBlockedRequestTarget(u: URL): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `不支持的协议 ${u.protocol}`;
  if (process.env["GAMEQA_ALLOW_PRIVATE"] === "1") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return "私网/环回地址";
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const priv =
      a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (priv) return "私网/环回地址";
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return "私网/环回地址";
  }
  return null;
}

/**
 * 原生 http/https 请求（支持 insecure_tls 跳过证书校验——fetch/undici 做不到）。
 * 超时、响应体 1MB 上限、latency 计时与 Go 版一致。
 */
export function doRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  insecure: boolean,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const blocked = isBlockedRequestTarget(u);
    if (blocked !== null) {
      reject(new Error(`目标被安全策略拒绝（${blocked}）：${url}。受信内网目标可设 GAMEQA_ALLOW_PRIVATE=1`));
      return;
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const start = performance.now();
    const req = mod.request(
      u,
      {
        method,
        headers: { ...headers },
        rejectUnauthorized: !insecure,
        timeout: timeoutMs,
        ...(insecure && isHttps ? { servername: u.hostname } : {}),
      },
      (resp) => {
        const chunks: Buffer[] = [];
        let size = 0;
        resp.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 1 << 20) chunks.push(c);
        });
        resp.on("end", () => {
          resolve({ statusCode: resp.statusCode ?? 0, latencyMs: Math.round(performance.now() - start), body: Buffer.concat(chunks).toString("utf-8") });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (body !== "" && !("Content-Type" in headers) && !("content-type" in headers)) {
      req.setHeader("Content-Type", "application/json");
    }
    req.end(body);
  });
}

/** "Key: Value" 行式请求头文本解析 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const i = t.indexOf(":");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// ---------- api_check ----------

/** 单接口断言：状态码 / 关键词 / 延迟上限 */
export async function executeAPICheck(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const url = str(extra, "url").trim();
  if (url === "") return [false, { message: "缺少 url" }];
  const method = str(extra, "method") || "GET";
  const headers = parseHeaders(str(extra, "headers"));
  const body = str(extra, "body");
  const keyword = str(extra, "keyword");
  const expected = Math.trunc(num(extra, "expected_status", 200));
  const maxLatency = Math.trunc(num(extra, "latency_ms", 0));
  const timeoutMS = Math.min(Math.max(num(extra, "timeout_ms", 10000), 1000), 60000);
  const insecure = bool(extra, "insecure_tls", false);

  const failed: string[] = [];
  const checks: Record<string, Json> = {};
  let res: HttpResult | null = null;
  try {
    res = await doRequest(method, url, headers, body, timeoutMS, insecure);
  } catch (err) {
    failed.push("请求失败: " + (err as Error).message);
  }
  if (res) {
    const statusOK = res.statusCode === expected;
    checks["status_code"] = res.statusCode;
    checks["status_ok"] = statusOK;
    if (!statusOK) failed.push(`状态码 ${res.statusCode} ≠ 期望 ${expected}`);
    if (keyword !== "") {
      const kwOK = res.body.includes(keyword);
      checks["keyword_found"] = kwOK;
      if (!kwOK) failed.push("响应未包含关键词: " + keyword);
    }
    if (maxLatency > 0) {
      const latOK = res.latencyMs <= maxLatency;
      checks["latency_ms"] = res.latencyMs;
      checks["latency_ok"] = latOK;
      if (!latOK) failed.push(`延迟 ${res.latencyMs}ms > 上限 ${maxLatency}ms`);
    }
    checks["body_snippet"] = res.body.length > 200 ? res.body.slice(0, 200) + "…" : res.body;
  }
  checks["method"] = method;
  checks["url"] = url;
  checks["latency_ms"] = res?.latencyMs ?? 0;
  const success = failed.length === 0;
  return [success, { message: success ? "接口检查通过" : "接口检查失败: " + failed.join("；"), checks }];
}

// ---------- api_load ----------

/** 并发压测：total 总请数 / concurrency 并发 / p95 延迟断言（k6 简化版） */
export async function executeAPILoad(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const url = str(extra, "url").trim();
  if (url === "") return [false, { message: "缺少 url" }];
  const total = Math.min(Math.trunc(num(extra, "total", 50)), 1000);
  const concurrency = Math.min(Math.trunc(num(extra, "concurrency", 5)), 50);
  const expected = Math.trunc(num(extra, "expected_status", 200));
  const p95Max = num(extra, "p95_ms", 0);
  const insecure = bool(extra, "insecure_tls", false);

  const latencies: number[] = [];
  let okCount = 0;
  let errSample = "";
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= total) return;
      try {
        const r = await doRequest("GET", url, {}, "", 10_000, insecure);
        if (r.statusCode === expected) {
          okCount++;
          latencies.push(r.latencyMs);
        }
      } catch (err) {
        if (errSample === "") errSample = (err as Error).message;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  latencies.sort((a, b) => a - b);
  const pct = (p: number): number => {
    if (latencies.length === 0) return 0;
    let idx = Math.floor(latencies.length * p);
    if (idx >= latencies.length) idx = latencies.length - 1;
    return latencies[idx];
  };
  const latMax = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const success = okCount === total && (p95Max === 0 || pct(0.95) <= p95Max);
  let msg = `性能冒烟: 成功 ${okCount}/${total}，p50=${pct(0.5)}ms，p95=${pct(0.95)}ms，max=${latMax}ms`;
  if (errSample !== "") msg += "，错误样本: " + errSample;
  return [
    success,
    {
      message: msg,
      total,
      http_ok: okCount,
      p50_ms: pct(0.5),
      p95_ms: pct(0.95),
      latency_max: latMax,
      err_sample: errSample,
    },
  ];
}

// ---------- api_flow ----------

/** 极简点路径取值：data.list.0.token（extractJSONPath） */
export function extractJSONPath(body: string, pathExpr: string): string {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    throw new Error("响应非 JSON");
  }
  let cur: unknown = root;
  for (const seg of pathExpr.trim().split(".")) {
    if (Array.isArray(cur)) {
      const idx = parseInt(seg, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) throw new Error(`数组下标 "${seg}" 越界`);
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      const node = cur as Record<string, unknown>;
      if (!(seg in node)) throw new Error(`路径段 "${seg}" 不存在`);
      cur = node[seg];
    } else {
      throw new Error(`路径段 "${seg}" 无法下钻`);
    }
  }
  if (cur !== null && typeof cur === "object") return JSON.stringify(cur);
  return String(cur);
}

interface FlowStep {
  name?: string;
  request?: { method?: string; url?: string; headers?: Record<string, Json>; body?: string };
  expect?: { status?: number; keyword?: string };
  save?: Record<string, string>;
}

/** 多步骤接口链：{{变量}} 替换 + save 提取，失败即止（fail-fast） */
export async function executeAPIFlow(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const raw = str(extra, "steps_json").trim();
  if (raw === "") return [false, { message: "缺少 steps_json（步骤定义）" }];
  let steps: FlowStep[];
  try {
    steps = JSON.parse(raw) as FlowStep[];
    if (!Array.isArray(steps)) throw new Error("非列表");
  } catch (err) {
    return [false, { message: "steps_json 解析失败: " + (err as Error).message }];
  }
  const vars: Record<string, string> = {};
  const stepResults: Record<string, Json>[] = [];
  let success = true;
  let failedStep = "";
  const insecure = bool(extra, "insecure_tls", false);

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const name = st.name || `步骤 ${i + 1}`;
    let method = st.request?.method ?? "GET";
    let url = st.request?.url ?? "";
    let headersText = "";
    for (const [k, v] of Object.entries(st.request?.headers ?? {})) headersText += `${k}: ${String(v)}\n`;
    let bodyStr = st.request?.body ?? "";
    for (const [k, v] of Object.entries(vars)) {
      url = url.split(`{{${k}}}`).join(v);
      bodyStr = bodyStr.split(`{{${k}}}`).join(v);
      headersText = headersText.split(`{{${k}}}`).join(v);
    }
    let stepOK = true;
    let stepErr = "";
    let res: HttpResult | null = null;
    try {
      res = await doRequest(method, url, parseHeaders(headersText), bodyStr, 15_000, insecure);
    } catch (err) {
      stepErr = (err as Error).message;
      stepOK = false;
    }
    if (res) {
      if (st.expect?.status !== undefined && res.statusCode !== st.expect.status) {
        stepOK = false;
        stepErr = `状态码 ${res.statusCode} ≠ ${st.expect.status}`;
      }
      if (st.expect?.keyword && !res.body.includes(st.expect.keyword)) {
        stepOK = false;
        stepErr = "未包含关键词: " + st.expect.keyword;
      }
      if (st.save && stepOK) {
        for (const [varName, jsonPath] of Object.entries(st.save)) {
          try {
            vars[varName] = extractJSONPath(res.body, jsonPath);
          } catch (err) {
            stepOK = false;
            stepErr = `提取 ${jsonPath} 失败: ${(err as Error).message}`;
          }
        }
      }
    }
    if (!stepOK && success) {
      success = false;
      failedStep = name;
    }
    stepResults.push({ step: i + 1, name, ok: stepOK, status_code: res?.statusCode ?? 0, latency_ms: res?.latencyMs ?? 0, error: stepErr });
    if (!stepOK) break; // fail-fast，与主流流程引擎一致
  }
  const msg = success
    ? `流程通过（${stepResults.length} 步）`
    : `流程失败于「${failedStep}」: ${String(stepResults[stepResults.length - 1]["error"])}`;
  return [success, { message: msg, steps: stepResults }];
}

// ---------- web_check ----------

/** 网站可用性检查：多 URL 全部通过才算通过 */
export async function executeWebCheck(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const urls: string[] = [];
  if (Array.isArray(extra["urls"])) {
    for (const u of extra["urls"] as Json[]) if (typeof u === "string" && u.trim() !== "") urls.push(u.trim());
  }
  const single = str(extra, "url").trim();
  if (single !== "") urls.unshift(single);
  if (urls.length === 0) return [false, { message: "缺少检查地址", hint: "extra.url 或 extra.urls 需至少一个 URL" }];

  const expected = typeof extra["expected_status"] === "number" && (extra["expected_status"] as number) > 0 ? Math.trunc(extra["expected_status"] as number) : 200;
  const keyword = str(extra, "keyword");
  const tv = typeof extra["timeout_ms"] === "number" ? (extra["timeout_ms"] as number) : 5000;
  const timeoutMS = tv >= 1000 && tv <= 30000 ? tv : 5000;
  const insecure = bool(extra, "insecure_tls", false);

  const results: Record<string, Json>[] = [];
  let passed = 0;
  for (const u of urls) {
    const r: Record<string, Json> = { url: u, status_code: 0, latency_ms: 0, keyword_found: false, ok: false };
    try {
      const res = await doRequest("GET", u, {}, "", timeoutMS, insecure);
      r["status_code"] = res.statusCode;
      r["latency_ms"] = res.latencyMs;
      if (keyword !== "") r["keyword_found"] = res.body.includes(keyword);
      r["ok"] = res.statusCode === expected && (keyword === "" || (r["keyword_found"] as boolean));
    } catch (err) {
      r["error"] = (err as Error).message;
    }
    if (r["ok"] as boolean) passed++;
    results.push(r);
  }
  const success = passed === urls.length && urls.length > 0;
  return [success, { message: `Web 检查通过 ${passed}/${urls.length}`, results, total: urls.length, passed }];
}

// ---------- port_check ----------

/** TCP 端口连通性检查（游戏登录服/网关端口监控） */
export function executePortCheck(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const host = str(extra, "host").trim();
  const port = Math.trunc(num(extra, "port", 0));
  if (host === "" || port <= 0 || port > 65535) return Promise.resolve([false, { message: "需要 host 与有效 port（1-65535）" }]);
  const expectOpen = bool(extra, "expect_open", true);
  const timeoutMS = num(extra, "timeout_ms", 3000);
  const addr = `${host}:${port}`;

  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (open: boolean, errMsg: string): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const latency = Math.round(performance.now() - start);
      const checks: Record<string, Json> = { addr, open, latency_ms: latency };
      let success = open === expectOpen;
      let msg = "";
      if (errMsg !== "" && !open) msg = `端口不可达 ${addr}: ${errMsg}`;
      else if (!success) msg = `端口 ${addr} 状态不符（open=${open}，期望 ${expectOpen}）`;
      else msg = `端口可达 ${addr}（${latency}ms）`;
      const maxLatency = num(extra, "latency_ms", 0);
      if (maxLatency > 0 && latency > maxLatency && success) {
        success = false;
        msg = `连接延迟 ${latency}ms > 上限 ${maxLatency}ms`;
      }
      resolve([success, { message: msg, checks }]);
    };
    sock.setTimeout(timeoutMS, () => done(false, "连接超时"));
    sock.on("connect", () => done(true, ""));
    sock.on("error", (err) => done(false, err.message));
  });
}

// ---------- cert_check ----------

/** TLS 证书到期检查（只读元数据，不校验信任链） */
export function executeCertCheck(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const host = str(extra, "host").trim();
  if (host === "") return Promise.resolve([false, { message: "缺少 host" }]);
  const port = Math.trunc(num(extra, "port", 443));
  const minDays = Math.trunc(num(extra, "min_days_valid", 14));
  const addr = `${host}:${port}`;

  return new Promise((resolve) => {
    const conn = tls.connect({
      host,
      port,
      rejectUnauthorized: false, // 只读取证书元数据
      ...(net.isIP(host) === 0 ? { servername: host } : {}), // IP 不能作 SNI servername
      timeout: 10_000,
    });
    let settled = false;
    const done = (ok: boolean, payload: Record<string, Json>): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve([ok, payload]);
    };
    conn.on("secureConnect", () => {
      const cert = conn.getPeerCertificate();
      if (!cert || !cert.valid_to) {
        done(false, { message: "对端未返回证书" });
        return;
      }
      const notAfter = new Date(cert.valid_to);
      const days = Math.trunc((notAfter.getTime() - Date.now()) / 86_400_000);
      const issuer = typeof cert.issuer === "object" && cert.issuer ? String((cert.issuer as Record<string, string>)["CN"] ?? "") : "";
      const subject = typeof cert.subject === "object" && cert.subject ? String((cert.subject as Record<string, string>)["CN"] ?? "") : "";
      const dateStr = notAfter.toISOString().slice(0, 10);
      const success = days >= minDays;
      const msg = success
        ? `证书剩余 ${days} 天（${issuer} 签发，${dateStr} 到期）`
        : `证书仅剩 ${days} 天（低于阈值 ${minDays} 天），${dateStr} 到期`;
      done(success, {
        message: msg,
        host: addr,
        subject,
        issuer,
        not_after: `${dateStr} ${notAfter.toISOString().slice(11, 19)}`,
        days_left: days,
        min_days: minDays,
      });
    });
    conn.on("timeout", () => done(false, { message: `TLS 握手超时 ${addr}` }));
    conn.on("error", (err) => done(false, { message: `TLS 握手失败 ${addr}: ${err.message}` }));
  });
}

// ---------- dns_check ----------

/** DNS 解析检查：解析成功 / 期望 IP 命中 */
export async function executeDNSCheck(job: Job): Promise<[boolean, Record<string, Json>]> {
  const extra = extraOf(job);
  const hostname = str(extra, "hostname").trim();
  if (hostname === "") return [false, { message: "缺少 hostname" }];
  const expected: string[] = [];
  const ei = extra["expected_ips"];
  if (typeof ei === "string") {
    for (const s of ei.split(",")) if (s.trim() !== "") expected.push(s.trim());
  } else if (Array.isArray(ei)) {
    for (const item of ei) if (typeof item === "string" && item !== "") expected.push(item);
  }

  let ips: string[];
  try {
    ips = (await dns.promises.lookup(hostname, { all: true })).map((r) => r.address);
  } catch (err) {
    return [false, { message: `解析失败 ${hostname}: ${(err as Error).message}` }];
  }
  const checks: Record<string, Json> = { hostname, resolved: ips };
  let success = ips.length > 0;
  if (expected.length > 0) {
    const hit = expected.some((e) => ips.includes(e));
    checks["expected"] = expected;
    checks["expected_hit"] = hit;
    if (!hit) success = false;
  }
  let msg = `DNS 解析 ${hostname} → ${ips.join(", ")}`;
  if (expected.length > 0) msg += `（期望命中 ${expected.join(",")}）`;
  if (!success) msg = "DNS 解析失败: " + msg;
  return [success, { message: msg, checks }];
}

// ---------- self_check ----------

/** 环境自检：存储/TLS/技能表/磁盘/任务存储/版本 */
export function executeSelfCheck(job: Job, store: Store): [boolean, Record<string, Json>] {
  void job;
  const checks: Record<string, Json> = {};
  const failed: string[] = [];

  try {
    store.healthCheck();
    checks["storage"] = "可写";
  } catch (err) {
    failed.push("存储不可写: " + (err as Error).message);
    checks["storage"] = "不可写";
  }

  const certPath = path.join(store.dataDir, "tls", "cert.pem");
  checks["tls_cert"] = fs.existsSync(certPath) ? "已配置" : "未生成（HTTP 模式）";

  checks["skills"] = SKILLS.length;
  if (SKILLS.length === 0) failed.push("技能表为空");

  try {
    const st = fs.statfsSync(store.dataDir);
    const freeMB = Math.round((st.bavail * st.bsize) / (1024 * 1024));
    checks["disk_free_mb"] = freeMB;
    if (freeMB < 100) failed.push("磁盘可用空间不足 100MB");
  } catch {
    checks["disk_free_mb"] = "未知";
  }

  try {
    if (JSON.stringify(store.listJobs()).length > 2) checks["jobs_store"] = "可读";
  } catch (err) {
    failed.push("任务存储读取失败: " + (err as Error).message);
  }

  checks["version"] = VERSION;
  const success = failed.length === 0;
  return [success, { message: success ? "环境自检通过" : "环境自检失败: " + failed.join("；"), checks }];
}

// ---------- 分发 / worker ----------

export async function executeBuiltin(job: Job, store: Store): Promise<[boolean, Record<string, Json>]> {
  const jt = str(extraOf(job), "job_type");
  switch (jt) {
    case "web_check":
      return executeWebCheck(job);
    case "api_check":
      return executeAPICheck(job);
    case "api_load":
      return executeAPILoad(job);
    case "api_flow":
      return executeAPIFlow(job);
    case "self_check":
      return executeSelfCheck(job, store);
    case "port_check":
      return executePortCheck(job);
    case "cert_check":
      return executeCertCheck(job);
    case "dns_check":
      return executeDNSCheck(job);
  }
  return [false, { message: "未知内置任务类型: " + jt }];
}

function summaryInt(summary: Record<string, Json>, key: string): number {
  const v = summary[key];
  return typeof v === "number" ? Math.trunc(v) : 0;
}

/** 执行单个内置任务：异常恢复、结果落盘、监控循环续排 */
export async function runBuiltinJob(store: Store, job: Job): Promise<void> {
  const id = typeof job["job_id"] === "number" ? job["job_id"] : 0;
  try {
    console.log(`[Builtin] 执行任务 #${id}`);
    store.heartbeat(BUILTIN_WEB_AGENT_ID, "running", id, nowFloat());
    const [success, summary] = await executeBuiltin(job, store);
    store.setJobResult(id, BUILTIN_WEB_AGENT_ID, success, null, summary);
    if (!success) notifyJobFailure(job, BUILTIN_WEB_AGENT_ID, summary);
    // 监控循环：看板把 repeat_minutes 放 extra（summary 读取是 Go 版断链，此处兜底才真正生效）
    const rm = summaryInt(summary, "repeat_minutes") || summaryInt(extraOf(job), "repeat_minutes");
    if (rm > 0) {
      const next: Job = {
        job_id: store.nextJobId(),
        platform: job["platform"],
        required_skills: job["required_skills"],
        extra: job["extra"],
        status: "pending",
        created_at: nowFloat(),
        result: null,
      };
      store.appendJob(next);
      console.log(`[Builtin] 监控循环: #${id} 完成，已排 #${String(next["job_id"])}（${rm} 分钟后）`);
    }
    console.log(`[Builtin] 任务 #${id} 完成: ${success}`);
  } catch (err) {
    console.error(`[Builtin] 任务 #${id} 异常:`, err);
    store.setJobResult(id, BUILTIN_WEB_AGENT_ID, false, null, { message: "内置执行器内部错误", error: (err as Error).message });
  } finally {
    store.heartbeat(BUILTIN_WEB_AGENT_ID, "idle", null, nowFloat());
  }
}

/**
 * 启动内置执行器 worker：周期领取 pending 内置任务并执行；每轮做失联超时兜底（reapStale）。
 * 返回停止函数。
 */
export function startBuiltinWorker(store: Store, intervalMs: number, staleMs: number): () => void {
  store.setAgent(BUILTIN_WEB_AGENT_ID, {
    agent_id: BUILTIN_WEB_AGENT_ID,
    platform: "web",
    skills: ["WebCheck", "APITest", "APIFlow", "LoadSmoke"],
    extra: { builtin: true },
    last_seen: nowFloat(),
    status: "idle",
    current_job_id: null,
  });
  const timer = setInterval(() => {
    const reaped = store.reapStale(staleMs / 1000);
    if (reaped.length > 0) console.log(`[Builtin] 失联超时清理: ${reaped.join(",")}`);
    const job = store.claimBuiltin();
    if (!job) return;
    void runBuiltinJob(store, job);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

