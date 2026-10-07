/**
 * E17 MCP 客户端：.tupigcode/mcp.json 配置 + SDK 握手/list/call + 工具桥。对应 issue #6。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig, connectMcpServers } from "../../src/engine/mcp";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.mjs");
const allow: CanUseToolFn = async () => ({ behavior: "allow" });

let dir: string;

function mkCtx(workDir: string): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir,
    sessionId: "s1",
  };
}

function writeMcpJson(workDir: string, servers: Record<string, any>) {
  fs.mkdirSync(path.join(workDir, ".tupigcode"), { recursive: true });
  fs.writeFileSync(path.join(workDir, ".tupigcode", "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-client-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadMcpConfig", () => {
  it("无 .tupigcode/mcp.json → null（零变化）", () => {
    expect(loadMcpConfig(dir)).toBeNull();
  });

  it("非法 JSON → null（不抛）", () => {
    fs.mkdirSync(path.join(dir, ".tupigcode"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tupigcode", "mcp.json"), "{broken");
    expect(loadMcpConfig(dir)).toBeNull();
  });

  it("合法配置 → mcpServers", () => {
    writeMcpJson(dir, { fake: { command: "node", args: ["x.mjs"] } });
    const cfg = loadMcpConfig(dir);
    expect(cfg?.mcpServers?.fake.command).toBe("node");
    expect(cfg?.mcpServers?.fake.args).toEqual(["x.mjs"]);
  });
});

describe("connectMcpServers", () => {
  it("未配置 → tools 空，不启动任何子进程", async () => {
    const mcp = await connectMcpServers(dir);
    expect(mcp.tools).toEqual([]);
    await mcp.close();
  });

  it("握手 + tools/list + tools/call 全往返", async () => {
    writeMcpJson(dir, { fake: { command: "node", args: [FIXTURE] } });
    const mcp = await connectMcpServers(dir);
    try {
      const names = mcp.tools.map((t) => t.name);
      expect(names).toContain("mcp_fake_echo");
      expect(names).toContain("mcp_fake_peek");

      const echo = mcp.tools.find((t) => t.name === "mcp_fake_echo")!;
      const r = await echo.call({ text: "hi" }, mkCtx(dir), allow);
      expect(String(r.data)).toContain("echo:hi");
    } finally {
      await mcp.close();
    }
  });

  it("工具桥透传 inputSchema 为 jsonSchema（description 带参数说明）", async () => {
    writeMcpJson(dir, { fake: { command: "node", args: [FIXTURE] } });
    const mcp = await connectMcpServers(dir);
    try {
      const echo = mcp.tools.find((t) => t.name === "mcp_fake_echo")!;
      expect((echo as any).jsonSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      });
      expect(echo.description({} as never)).toContain("JSON Schema");
      expect(echo.description({} as never)).toContain("回显文本");
    } finally {
      await mcp.close();
    }
  });

  it("readOnlyHint → isReadOnly 映射", async () => {
    writeMcpJson(dir, { fake: { command: "node", args: [FIXTURE] } });
    const mcp = await connectMcpServers(dir);
    try {
      const peek = mcp.tools.find((t) => t.name === "mcp_fake_peek")!;
      const touch = mcp.tools.find((t) => t.name === "mcp_fake_touch")!;
      expect(peek.isReadOnly({})).toBe(true);
      expect(touch.isReadOnly({})).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  it("command 不存在 → 从不 reject，降级 tools 空", async () => {
    writeMcpJson(dir, { bad: { command: "definitely-not-exist-xyz-123", args: [] } });
    const mcp = await connectMcpServers(dir);
    expect(mcp.tools).toEqual([]);
    await mcp.close();
  });

  it("部分 server 失败：好的照常接入，坏的跳过", async () => {
    writeMcpJson(dir, {
      good: { command: "node", args: [FIXTURE] },
      bad: { command: "definitely-not-exist-xyz-123", args: [] },
    });
    const mcp = await connectMcpServers(dir);
    try {
      expect(mcp.tools.some((t) => t.name.startsWith("mcp_good_"))).toBe(true);
      expect(mcp.tools.some((t) => t.name.startsWith("mcp_bad_"))).toBe(false);
    } finally {
      await mcp.close();
    }
  });
});

afterAll(() => {
  // fixture 子进程均由 close() 收尾，此处兜底
});
