/**
 * E63 MCP timeout + 断开摘除 + 退避重连（issue #60）
 *
 * - wrapMcpTool：entry.timeout → callTool RequestOptions.timeout；未配不传
 * - handleServerDrop：断开即摘除该 server 全部工具 + fireChanged + 告警
 * - backoffDelayMs：1s→2s→4s…cap 30s
 * - reconnectLoop：退避重试成功返回 true、耗尽 onGaveUp 返回 false
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  wrapMcpTool,
  handleServerDrop,
  backoffDelayMs,
  reconnectLoop,
  clearMcpApprovals,
  type McpServerEntry,
  type McpToolDef,
} from "../../src/engine/mcp";
import type { Tool } from "../../src/engine/Tool";

const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({ command: "noop", ...over });

beforeEach(() => clearMcpApprovals());
afterEach(() => clearMcpApprovals());

describe("callTool timeout 透传", () => {
  async function callAndCapture(e: McpServerEntry, def: McpToolDef = { name: "t" }) {
    let captured: any[] = [];
    const client = {
      callTool: async (...args: any[]) => {
        captured = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const tool = wrapMcpTool("s", def, client as any, e);
    await tool.call({}, { workDir: "/tmp" } as any, vi.fn() as any);
    return captured;
  }

  it("entry.timeout=1234 → options.timeout 透传", async () => {
    const args = await callAndCapture(entry({ timeout: 1234 }));
    expect(args).toHaveLength(3);
    expect(args[2]).toEqual({ timeout: 1234 });
  });

  it("未配 timeout → 不传 options（走 SDK 默认）", async () => {
    const args = await callAndCapture(entry());
    expect(args.length === 2 || args[2] === undefined).toBe(true);
  });
});

describe("handleServerDrop", () => {
  it("摘除该 server 全部工具、保留其他 server、fireChanged + 告警", () => {
    const serverTools = new Map<string, Tool[]>([
      ["a", [{ name: "mcp_a_x" }, { name: "mcp_a_y" }] as Tool[]],
      ["b", [{ name: "mcp_b_z" }] as Tool[]],
    ]);
    const fireChanged = vi.fn();
    const onWarn = vi.fn();
    handleServerDrop("a", serverTools, fireChanged, onWarn);
    expect(serverTools.has("a")).toBe(false);
    expect(serverTools.get("b")).toHaveLength(1);
    expect(fireChanged).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("断开"));
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('"a"'));
  });

  it("server 不存在 → 不 fireChanged", () => {
    const fireChanged = vi.fn();
    handleServerDrop("ghost", new Map(), fireChanged, vi.fn());
    expect(fireChanged).not.toHaveBeenCalled();
  });
});

describe("backoffDelayMs", () => {
  it("1s 起指数翻倍、30s 封顶", () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(6)).toBe(30_000);
    expect(backoffDelayMs(20)).toBe(30_000);
  });
});

describe("reconnectLoop", () => {
  it("首次成功 → true，不调 onGaveUp", async () => {
    const tryConnect = vi.fn(async () => true);
    const onGaveUp = vi.fn();
    const ok = await reconnectLoop({ tryConnect, onGaveUp, sleep: async () => {} });
    expect(ok).toBe(true);
    expect(tryConnect).toHaveBeenCalledTimes(1);
    expect(onGaveUp).not.toHaveBeenCalled();
  });

  it("退避重试第 3 次成功 → true，延迟序列 1s/2s", async () => {
    const delays: number[] = [];
    const tryConnect = vi.fn(async () => delays.length >= 3);
    const ok = await reconnectLoop({
      tryConnect,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(ok).toBe(true);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(tryConnect).toHaveBeenCalledTimes(3);
  });

  it("耗尽（默认 5 次）→ false + onGaveUp", async () => {
    const tryConnect = vi.fn(async () => false);
    const onGaveUp = vi.fn();
    const ok = await reconnectLoop({ tryConnect, onGaveUp, sleep: async () => {} });
    expect(ok).toBe(false);
    expect(tryConnect).toHaveBeenCalledTimes(5);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
  });

  it("maxAttempts 可配", async () => {
    const tryConnect = vi.fn(async () => false);
    const ok = await reconnectLoop({ tryConnect, maxAttempts: 2, sleep: async () => {} });
    expect(ok).toBe(false);
    expect(tryConnect).toHaveBeenCalledTimes(2);
  });
});
