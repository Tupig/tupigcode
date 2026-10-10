/**
 * G1 gameqa 内置执行器：8 类任务真实执行回归（builtin.go 移植 + repeat_minutes 断链修复验证）。
 * 全部打本地回环，不依赖外网。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store, type Job, type Json } from "../../src/gameqa/store";
import {
  executeAPICheck,
  executeAPILoad,
  executeAPIFlow,
  executeWebCheck,
  executePortCheck,
  executeCertCheck,
  executeDNSCheck,
  executeSelfCheck,
  executeBuiltin,
  runBuiltinJob,
  startBuiltinWorker,
  extractJSONPath,
  parseHeaders,
} from "../../src/gameqa/builtin";

let target: http.Server;
let targetBase: string;
let tmpDir: string;

beforeAll(async () => {
  // g2 用本机 HTTP server 当上游——放行私网目标（fix #118 SSRF 闸的测试豁免）
  process.env["GAMEQA_ALLOW_PRIVATE"] = "1";
  target = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "hello-ok", data: { token: "tk-123" } }));
    } else if (u.pathname === "/echo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ got: u.searchParams.get("tok") ?? "" }));
    } else if (u.pathname === "/boom") {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env["GAMEQA_ALLOW_PRIVATE"];
  await new Promise<void>((r) => target.close(() => r()));
});

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-bi-"));
  store = new Store(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function job(extra: Record<string, Json>): Job {
  return { job_id: 1, platform: "web", status: "running", required_skills: [], extra, created_at: 1 };
}

describe("api_check / api_load / api_flow", () => {
  it("api_check：状态码+关键词通过；期望不符失败；缺 url 失败", async () => {
    const [ok, sum] = await executeAPICheck(job({ job_type: "api_check", url: `${targetBase}/ok`, keyword: "hello-ok", expected_status: 200 }));
    expect(ok).toBe(true);
    expect(sum["message"]).toBe("接口检查通过");
    expect((sum["checks"] as Record<string, unknown>)["status_ok"]).toBe(true);

    const [bad] = await executeAPICheck(job({ job_type: "api_check", url: `${targetBase}/ok`, expected_status: 500 }));
    expect(bad).toBe(false);
    const [noUrl, noUrlSum] = await executeAPICheck(job({ job_type: "api_check" }));
    expect(noUrl).toBe(false);
    expect(noUrlSum["message"]).toBe("缺少 url");
    const [kwMiss, kwSum] = await executeAPICheck(job({ job_type: "api_check", url: `${targetBase}/ok`, keyword: "不存在的词" }));
    expect(kwMiss).toBe(false);
    expect(String(kwSum["message"])).toContain("响应未包含关键词");
    const [down] = await executeAPICheck(job({ job_type: "api_check", url: "http://127.0.0.1:1/x", timeout_ms: 1000 }));
    expect(down).toBe(false);
  });

  it("api_load：并发冒烟全成功；p95 断言", async () => {
    const [ok, sum] = await executeAPILoad(job({ job_type: "api_load", url: `${targetBase}/ok`, total: 12, concurrency: 4 }));
    expect(ok).toBe(true);
    expect(sum["http_ok"]).toBe(12);
    expect(sum["total"]).toBe(12);
    expect(Number(sum["p95_ms"])).toBeGreaterThanOrEqual(0);
  });

  it("api_flow：{{变量}} 替换 + save 提取；失败即止", async () => {
    const steps = [
      { name: "取token", request: { method: "GET", url: `${targetBase}/ok` }, expect: { status: 200 }, save: { tok: "data.token" } },
      { name: "带token", request: { method: "GET", url: `${targetBase}/echo?tok={{tok}}` }, expect: { status: 200, keyword: "tk-123" } },
    ];
    const [ok, sum] = await executeAPIFlow(job({ job_type: "api_flow", steps_json: JSON.stringify(steps) }));
    expect(ok).toBe(true);
    expect(String(sum["message"])).toContain("流程通过（2 步）");

    const failing = [
      { name: "第一步就败", request: { method: "GET", url: `${targetBase}/boom` }, expect: { status: 200 } },
      { name: "不该执行", request: { method: "GET", url: `${targetBase}/ok` } },
    ];
    const [bad, badSum] = await executeAPIFlow(job({ job_type: "api_flow", steps_json: JSON.stringify(failing) }));
    expect(bad).toBe(false);
    expect(String(badSum["message"])).toContain("第一步就败");
    expect((badSum["steps"] as unknown[]).length).toBe(1);

    const [noSteps, msg] = await executeAPIFlow(job({ job_type: "api_flow" }));
    expect(noSteps).toBe(false);
    expect(msg["message"]).toBe("缺少 steps_json（步骤定义）");
  });
});

describe("web_check / 诊断", () => {
  it("web_check：多 URL 全过才通过；关键词；缺地址失败", async () => {
    const [ok, sum] = await executeWebCheck(job({ job_type: "web_check", urls: [`${targetBase}/ok`, `${targetBase}/echo`] }));
    expect(ok).toBe(true);
    expect(sum["passed"]).toBe(2);
    const [kwOk] = await executeWebCheck(job({ job_type: "web_check", url: `${targetBase}/ok`, keyword: "hello-ok" }));
    expect(kwOk).toBe(true);
    const [kwBad] = await executeWebCheck(job({ job_type: "web_check", url: `${targetBase}/ok`, keyword: "不存在的词" }));
    expect(kwBad).toBe(false);
    const [bad] = await executeWebCheck(job({ job_type: "web_check", urls: [`${targetBase}/ok`, `${targetBase}/missing`] }));
    expect(bad).toBe(false);
    const [noUrl, msg] = await executeWebCheck(job({ job_type: "web_check" }));
    expect(noUrl).toBe(false);
    expect(msg["message"]).toBe("缺少检查地址");
  });

  it("SSRF 闸（fix #118）：默认拒绝私网/环回目标，GAMEQA_ALLOW_PRIVATE=1 放开", async () => {
    const bak = process.env["GAMEQA_ALLOW_PRIVATE"];
    delete process.env["GAMEQA_ALLOW_PRIVATE"];
    try {
      const [ok, sum] = await executeWebCheck(job({ job_type: "web_check", url: `${targetBase}/ok` }));
      expect(ok).toBe(false);
      const first = (sum["results"] as any[])[0];
      expect(String(first["error"])).toContain("安全策略拒绝");
    } finally {
      if (bak !== undefined) process.env["GAMEQA_ALLOW_PRIVATE"] = bak;
    }
  });

  it("port_check：open 断言 + 期望关闭", async () => {
    const port = (target.address() as AddressInfo).port;
    const [ok, sum] = await executePortCheck(job({ job_type: "port_check", host: "127.0.0.1", port, expect_open: true }));
    expect(ok).toBe(true);
    expect(String(sum["message"])).toContain("端口可达");

    // 拿一个必然关闭的端口：连上后立刻关掉
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const [closed] = await executePortCheck(job({ job_type: "port_check", host: "127.0.0.1", port: closedPort, expect_open: false }));
    expect(closed).toBe(true);

    const [noHost] = await executePortCheck(job({ job_type: "port_check", host: "", port: 0 }));
    expect(noHost).toBe(false);
  });

  it("cert_check：缺 host 失败；拒绝连接快速失败", async () => {
    const [noHost, msg] = await executeCertCheck(job({ job_type: "cert_check" }));
    expect(noHost).toBe(false);
    expect(msg["message"]).toBe("缺少 host");
    const [refused] = await executeCertCheck(job({ job_type: "cert_check", host: "127.0.0.1", port: 1, min_days_valid: 1 }));
    expect(refused).toBe(false);
  });

  it("dns_check：解析成功 + 期望 IP 命中/未命中", async () => {
    const [ok, sum] = await executeDNSCheck(job({ job_type: "dns_check", hostname: "localhost" }));
    expect(ok).toBe(true);
    const resolved = (sum["checks"] as Record<string, unknown>)["resolved"] as string[];
    expect(resolved.length).toBeGreaterThan(0);
    const [hit] = await executeDNSCheck(job({ job_type: "dns_check", hostname: "localhost", expected_ips: resolved.join(",") }));
    expect(hit).toBe(true);
    const [miss] = await executeDNSCheck(job({ job_type: "dns_check", hostname: "localhost", expected_ips: "203.0.113.99" }));
    expect(miss).toBe(false);
    const [noHost] = await executeDNSCheck(job({ job_type: "dns_check" }));
    expect(noHost).toBe(false);
  });
});

describe("self_check / 分发 / worker", () => {
  it("self_check：存储可读写 + 检查项齐全", () => {
    const [ok, sum] = executeSelfCheck(job({ job_type: "self_check" }), store);
    expect(ok).toBe(true);
    const checks = sum["checks"] as Record<string, unknown>;
    expect(checks["storage"]).toBe("可写");
    expect(checks["jobs_store"]).toBe("可读");
    expect(checks["skills"]).toBeGreaterThan(50);
    expect(typeof checks["disk_free_mb"]).toBe("number");
    expect(typeof checks["version"]).toBe("string");
  });

  it("executeBuiltin 分发 + 未知类型", async () => {
    const [ok] = await executeBuiltin(job({ job_type: "self_check" }), store);
    expect(ok).toBe(true);
    const [unknown, msg] = await executeBuiltin(job({ job_type: "not_a_type" }), store);
    expect(unknown).toBe(false);
    expect(String(msg["message"])).toContain("未知内置任务类型");
  });

  it("runBuiltinJob：结果落盘 + extra.repeat_minutes 续排（Go 断链修复）", async () => {
    const id = store.nextJobId();
    const j: Job = { job_id: id, platform: "web", status: "running", required_skills: [], extra: { job_type: "self_check", repeat_minutes: 5 }, created_at: 1 };
    store.appendJob(j);
    await runBuiltinJob(store, j);
    const after = store.findJob(id);
    expect(after?.["status"]).toBe("passed");
    expect((after?.["result"] as Record<string, unknown>)["agent_id"]).toBe("builtin-web");
    // 续排出下一条 pending
    expect(store.listJobs().total).toBe(2);
    const next = store.listJobs().items.find((x) => x["job_id"] !== id);
    expect(next?.["status"]).toBe("pending");
    expect((next?.["extra"] as Record<string, unknown>)["repeat_minutes"]).toBe(5);
  });

  it("startBuiltinWorker：领取 web 内置任务并跑完", async () => {
    const stop = startBuiltinWorker(store, 30, 60_000);
    try {
      expect(store.hasAgent("builtin-web")).toBe(true);
      const id = store.nextJobId();
      store.appendJob({ job_id: id, platform: "web", status: "pending", required_skills: [], extra: { job_type: "self_check" }, created_at: Date.now() / 1000, result: null });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && store.findJob(id)?.["status"] !== "passed") {
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(store.findJob(id)?.["status"]).toBe("passed");
    } finally {
      stop();
    }
  });
});

describe("工具函数", () => {
  it("extractJSONPath：点路径/数组/缺失", () => {
    expect(extractJSONPath(`{"a":{"b":"c"}}`, "a.b")).toBe("c");
    expect(extractJSONPath(`{"list":[{"t":"x"}]}`, "list.0.t")).toBe("x");
    expect(() => extractJSONPath(`{"a":1}`, "a.b")).toThrow("无法下钻");
    expect(() => extractJSONPath(`{"l":[]}`, "l.5")).toThrow("越界");
    expect(() => extractJSONPath(`{"a":1}`, "zzz")).toThrow("不存在");
    expect(() => extractJSONPath("not-json", "a")).toThrow("响应非 JSON");
    expect(extractJSONPath(`{"o":{"x":1}}`, "o")).toBe(`{"x":1}`);
  });

  it("parseHeaders：行式解析", () => {
    expect(parseHeaders("A: 1\nB:two\n\n  C: 3  ")).toEqual({ A: "1", B: "two", C: "3" });
    expect(parseHeaders("no-colon\n:bad")).toEqual({});
  });
});
