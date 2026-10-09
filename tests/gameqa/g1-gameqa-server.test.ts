/**
 * G1 gameqa 编排服务：API 合同集成测试（server/main.go 移植回归）。
 * 起真实 http 服务（端口 0），按 Python/Go 版行为断言。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";

let dir: string;
let staticDir: string;
let store: Store;
let server: http.Server;
let base: string;
let tokenBackup: string | undefined;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-srv-"));
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-static-"));
  fs.writeFileSync(path.join(staticDir, "index.html"), "<html><body>看板</body></html>");
  fs.writeFileSync(path.join(staticDir, "app.js"), "console.log(1)");
  store = new Store(dir);
  server = http.createServer(createGameqaServer(store, staticDir));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenBackup = process.env["PLATFORM_TOKEN"];
  delete process.env["PLATFORM_TOKEN"];
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(staticDir, { recursive: true, force: true });
  if (tokenBackup === undefined) delete process.env["PLATFORM_TOKEN"];
  else process.env["PLATFORM_TOKEN"] = tokenBackup;
  delete process.env["MCP_SERVER_URL"];
});

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const resp = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

describe("基础端点", () => {
  it("health / version / skills", async () => {
    const h = await api("GET", "/api/health");
    expect(h.status).toBe(200);
    expect(h.json.ok).toBe(true);
    expect((await api("GET", "/api/version")).json.version).toBeTruthy();
    const s = await api("GET", "/api/skills");
    expect(s.json.total).toBeGreaterThanOrEqual(50);
    expect(s.json.items[0]).toHaveProperty("platforms");
  });

  it("看板 index 与 static 资源 no-cache", async () => {
    const idx = await fetch(base + "/");
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("看板");
    const js = await fetch(base + "/static/app.js");
    expect(js.headers.get("cache-control")).toBe("no-cache");
    expect((await fetch(base + "/static/missing.js")).status).toBe(404);
    expect((await fetch(base + "/static/")).status).toBe(404); // 目录列表关闭
  });
});

describe("Agent 注册 / 心跳 / 认证", () => {
  it("注册→心跳→列表；未注册心跳 404", async () => {
    const r = await api("POST", "/api/agents/register", { agent_id: "a-1", platform: "mac", skills: ["PlayMode"] });
    expect(r.json).toEqual({ ok: true, agent_id: "a-1" });
    expect((await api("POST", "/api/agents/heartbeat", { agent_id: "a-1", status: "idle", current_job_id: null })).status).toBe(200);
    expect((await api("POST", "/api/agents/heartbeat", { agent_id: "ghost", status: "idle" })).status).toBe(404);
    const list = await api("GET", "/api/agents");
    expect(list.json.total).toBe(1);
  });

  it("PLATFORM_TOKEN：除 health/version 外 /api/* 要求令牌", async () => {
    process.env["PLATFORM_TOKEN"] = "sekrit";
    expect((await api("GET", "/api/jobs")).status).toBe(401);
    expect((await api("GET", "/api/jobs", undefined, { "X-Platform-Token": "sekrit" })).status).toBe(200);
    expect((await api("GET", "/api/jobs", undefined, { "X-Platform-Token": "wrong" })).status).toBe(401);
    expect((await api("GET", "/api/health")).status).toBe(200);
    expect((await api("GET", "/api/version")).status).toBe(200);
  });

  it("PLATFORM_TOKEN：报告页 /report /allure 也要求令牌（header 或 ?token=）（fix #117）", async () => {
    process.env["PLATFORM_TOKEN"] = "sekrit";
    const page = (p: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(base + p, { headers });
    expect((await page("/report")).status).toBe(401);
    expect((await page("/allure")).status).toBe(401);
    expect((await page("/report", { "X-Platform-Token": "sekrit" })).status).toBe(200);
    expect((await page("/report", { "X-Platform-Token": "wrong" })).status).toBe(401);
    expect((await fetch(base + "/allure?token=sekrit")).status).toBe(200);
    expect((await fetch(base + "/allure?token=wrong")).status).toBe(401);
    // 无 token 模式下报告页照常开放
    delete process.env["PLATFORM_TOKEN"];
    expect((await page("/report")).status).toBe(200);
  });

  it("Content-Type 非 JSON → 415；超 1MB → 413", async () => {
    const r1 = await fetch(base + "/api/jobs", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(r1.status).toBe(415);
    const big = JSON.stringify({ platform: "mac", pad: "x".repeat(1 << 21) });
    const r2 = await fetch(base + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
    expect(r2.status).toBe(413);
  });
});

describe("任务 API 合同", () => {
  it("创建→列表→详情→poll（包装 {job}）→ result→终态", async () => {
    await api("POST", "/api/agents/register", { agent_id: "a-2", platform: "mac", skills: ["PlayMode"] });
    const c = await api("POST", "/api/jobs", {
      platform: "mac",
      required_skills: ["PlayMode"],
      unity_project_path: "/proj",
      test_filter: "Foo.*",
      extra: { note: "n1" },
    });
    expect(c.json.ok).toBe(true);
    const id = c.json.job_id as number;

    const detail = await api("GET", `/api/jobs/${id}`);
    expect(detail.json).toMatchObject({ job_id: id, platform: "mac", status: "pending", unity_project_path: "/proj", test_filter: "Foo.*" });
    expect(detail.json.result).toBeNull();

    // 平台不匹配 / 技能不足 → null
    expect((await api("GET", `/api/jobs/poll/ios?skills=PlayMode`)).json.job).toBeNull();
    expect((await api("GET", `/api/jobs/poll/mac?skills=EditMode`)).json.job).toBeNull();

    const polled = await api("GET", `/api/jobs/poll/mac?skills=PlayMode`);
    expect(polled.json.job).toMatchObject({ job_id: id, status: "running" });
    expect(typeof polled.json.job.started_at).toBe("number");

    // 未注册 agent 上报 → 403；已注册 → 通过
    expect((await api("POST", "/api/jobs/result", { job_id: id, agent_id: "ghost", success: true })).status).toBe(403);
    expect((await api("POST", "/api/jobs/result", { job_id: id, agent_id: "a-2", success: true, log_path: "/tmp/x.log", summary: { message: "ok" } })).json.ok).toBe(true);
    expect((await api("GET", `/api/jobs/${id}`)).json).toMatchObject({ status: "passed", result: { agent_id: "a-2", success: true } });

    // 终态任务 poll 不再返回
    expect((await api("GET", `/api/jobs/poll/mac?skills=PlayMode`)).json.job).toBeNull();
    // 未知 job result → 404
    expect((await api("POST", "/api/jobs/result", { job_id: 999999, agent_id: "a-2", success: true })).status).toBe(404);
  });

  it("cancel：pending→cancelled；passed 409；delete 移除；cleanup 计数", async () => {
    const c1 = await api("POST", "/api/jobs", { platform: "linux", required_skills: [] });
    const id1 = c1.json.job_id;
    expect((await api("POST", `/api/jobs/${id1}/cancel`)).json).toEqual({ ok: true, status: "cancelled" });
    expect((await api("POST", `/api/jobs/${id1}/cancel`)).status).toBe(200); // 幂等

    const c2 = await api("POST", "/api/jobs", { platform: "linux", required_skills: [] });
    const id2 = c2.json.job_id;
    await api("POST", "/api/agents/register", { agent_id: "a-3", platform: "linux", skills: [] });
    await api("GET", `/api/jobs/poll/linux`);
    await api("POST", "/api/jobs/result", { job_id: id2, agent_id: "a-3", success: false, summary: {} });
    expect((await api("POST", `/api/jobs/${id2}/cancel`)).status).toBe(409);

    expect((await api("POST", "/api/jobs/cleanup")).json.removed).toBe(2);
    expect((await api("DELETE", `/api/jobs/${id1}`)).status).toBe(404); // 已被 cleanup
    expect((await api("GET", `/api/jobs/${id1}`)).status).toBe(404);
    expect((await api("DELETE", "/api/jobs/424242")).status).toBe(404);
  });

  it("artifacts 上传≤10/列举/读取/非法名 400/未注册 403", async () => {
    await api("POST", "/api/agents/register", { agent_id: "a-4", platform: "android", skills: [] });
    const c = await api("POST", "/api/jobs", { platform: "android" });
    const id = c.json.job_id;
    const up = await api("POST", "/api/jobs/artifacts", {
      job_id: id,
      agent_id: "a-4",
      files: [
        { name: "steps.json", content: `{"n":1}` },
        { name: "tail.log", content: "line" },
      ],
    });
    expect(up.json).toEqual({ ok: true, stored: 2 });
    const list = await api("GET", `/api/jobs/artifacts?job_id=${id}`);
    expect(list.json.files.map((f: any) => f.name).sort()).toEqual(["steps.json", "tail.log"]);
    const read = await fetch(`${base}/api/jobs/artifacts/steps.json?job_id=${id}`);
    expect(await read.text()).toBe(`{"n":1}`);
    expect((await api("POST", "/api/jobs/artifacts", { job_id: id, agent_id: "ghost", files: [] })).status).toBe(403);
    expect((await api("POST", "/api/jobs/artifacts", { job_id: id, agent_id: "a-4", files: [{ name: "../evil", content: "x" }] })).status).toBe(400);
    expect((await api("GET", `/api/jobs/artifacts?job_id=abc`)).status).toBe(400);
    const files11 = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    expect((await api("POST", "/api/jobs/artifacts", { job_id: id, agent_id: "a-4", files: files11 })).status).toBe(400);
  });

  it("generate-test 无 OPENAI_API_KEY → error 字段；空值回 null", async () => {
    delete process.env["OPENAI_API_KEY"];
    const r = await api("POST", "/api/generate-test", { prompt: "点击设置打开面板" });
    expect(r.json.code).toBeNull();
    expect(r.json.error).toBe("OPENAI_API_KEY 未配置");
  });
});

describe("MCP 代理", () => {
  it("execute-tool 校验 tool_name 白名单；不可用上游返回 error 字段", async () => {
    expect((await api("POST", "/api/mcp/execute-tool", {})).status).toBe(400);
    expect((await api("POST", "/api/mcp/execute-tool", { tool_name: "../evil" })).status).toBe(400);
    process.env["MCP_SERVER_URL"] = "http://127.0.0.1:1/mcp"; // 必失败上游
    try {
      const r = await api("POST", "/api/mcp/execute-tool", { tool_name: "run_tests", tool_params: {} });
      expect(r.status).toBe(200);
      expect(r.json).toHaveProperty("error");
      const st = await api("GET", "/api/mcp/status");
      expect(st.json.available).toBe(false);
      expect(st.json.instances).toEqual({});
    } finally {
      delete process.env["MCP_SERVER_URL"];
    }
  });
});
