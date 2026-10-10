/**
 * G8 gameqa MCP 业务端点集成（refs #129 缺口1）：fake MCP 上游，覆盖 400 校验分支与转发成功分支。
 * MCP_SERVER_URL 指向本机 fake 上游（端口 0），断言请求转发载荷与响应透传。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";

let upstream: http.Server;
let upstreamBase: string;
let received: Array<{ url: string; body: unknown }>;
let server: http.Server;
let base: string;
let mcpUrlBackup: string | undefined;

beforeEach(async () => {
  received = [];
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, echo_url: req.url, echo_body: raw ? JSON.parse(raw) : null }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;

  mcpUrlBackup = process.env["MCP_SERVER_URL"];
  process.env["MCP_SERVER_URL"] = upstreamBase;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-mcp-"));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-mcp-static-"));
  fs.writeFileSync(path.join(staticDir, "index.html"), "<html></html>");
  const store = new Store(dir);
  server = http.createServer(createGameqaServer(store, staticDir));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (mcpUrlBackup === undefined) delete process.env["MCP_SERVER_URL"];
  else process.env["MCP_SERVER_URL"] = mcpUrlBackup;
});

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

describe("execute-tool", () => {
  it("缺 tool_name / 非法字符 → 400；成功 → 转发 /tools/<name> 并透传", async () => {
    expect((await api("POST", "/api/mcp/execute-tool", {})).status).toBe(400);
    expect((await api("POST", "/api/mcp/execute-tool", { tool_name: "../etc" })).status).toBe(400);

    const ok = await api("POST", "/api/mcp/execute-tool", {
      tool_name: "get_scene_info",
      tool_params: { scene_path: "Assets/A.unity" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(received.at(-1)!.url).toBe("/mcp/tools/get_scene_info");
    expect(received.at(-1)!.body).toEqual({ scene_path: "Assets/A.unity" });
  });
});

describe("batch-execute", () => {
  it("缺 tools 键按空列表；tools 非列表 → 400；列表 → 转发", async () => {
    const missing = await api("POST", "/api/mcp/batch-execute", {});
    expect(missing.status).toBe(200);
    expect(received.at(-1)!.url).toBe("/mcp/tools/batch_execute");
    expect(received.at(-1)!.body).toEqual({ tools: [] });

    expect((await api("POST", "/api/mcp/batch-execute", { tools: "nope" })).status).toBe(400);

    const list = await api("POST", "/api/mcp/batch-execute", {
      tools: [{ tool_name: "a" }, { tool_name: "b" }],
    });
    expect(list.status).toBe(200);
    expect(list.json.echo_body.tools).toHaveLength(2);
  });
});

describe("set-active-instance / manage-scene / execute-menu-item", () => {
  it("必填校验 400 + 成功转发（manage-scene props 合并）", async () => {
    expect((await api("POST", "/api/mcp/set-active-instance", {})).status).toBe(400);
    const inst = await api("POST", "/api/mcp/set-active-instance", { instance_id: "i-1" });
    expect(inst.status).toBe(200);
    expect(received.at(-1)!.body).toEqual({ instance_id: "i-1" });

    expect((await api("POST", "/api/mcp/manage-scene", { action: "create" })).status).toBe(400);
    const scene = await api("POST", "/api/mcp/manage-scene", {
      action: "create",
      scene_path: "Assets/New.unity",
      properties: { light: "sun", action: "override" },
    });
    expect(scene.status).toBe(200);
    // props 覆盖同名键（mcpMergeProps 语义）
    expect(received.at(-1)!.url).toBe("/mcp/tools/manage_scene");
    expect(received.at(-1)!.body).toEqual({ action: "override", scene_path: "Assets/New.unity", light: "sun" });

    expect((await api("POST", "/api/mcp/execute-menu-item", {})).status).toBe(400);
    const menu = await api("POST", "/api/mcp/execute-menu-item", { menu_path: "File/Save" });
    expect(menu.status).toBe(200);
    expect(received.at(-1)!.body).toEqual({ menu_path: "File/Save" });
  });
});

describe("mcp status / project-info", () => {
  it("status 透传 available+instances；project-info 透传资源", async () => {
    const st = await api("GET", "/api/mcp/status");
    expect(st.status).toBe(200);
    expect(st.json.available).toBe(true);
    expect(st.json.instances.ok).toBe(true);

    const pi = await api("GET", "/api/mcp/project-info");
    expect(pi.status).toBe(200);
    expect(pi.json.ok).toBe(true);
    expect(received.at(-1)!.url).toBe("/mcp/resources/project_info");
  });

  it("上游不可达 → available false 且端点返回 error 结构", async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const st = await api("GET", "/api/mcp/status");
    expect(st.json.available).toBe(false);
    const ex = await api("POST", "/api/mcp/execute-tool", { tool_name: "x" });
    expect(ex.status).toBe(200); // 代理层不吞上游错误，以 JSON error 透传（与 Go 版一致）
    expect(ex.json.error).toBeTruthy();
  });
});
