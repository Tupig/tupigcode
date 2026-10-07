/**
 * E62 MCP list_changed 动态刷新（issue #59）
 *
 * - makeServerRefresher：重拉 diff、变更才 fireChanged、失败保留旧工具
 * - registerListChanged：订阅 notifications/tools/list_changed 并触发刷新
 * - connectMcpServers 的 onToolsChanged 回调接线（无配置零回调）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  makeServerRefresher, wrapMcpTool,
  registerListChanged,
  clearMcpApprovals,
  type McpServerEntry,
  type McpToolDef,
} from "../../src/engine/mcp";
import type { Tool } from "../../src/engine/Tool";

const entry: McpServerEntry = { command: "noop", approval: "allow" };

function makeEnv(initialDefs: McpToolDef[], next?: McpToolDef[] | Error) {
  const client = {
    callTool: async () => ({ content: [] }),
    listTools: vi.fn(async () => ({ tools: typeof next === "object" && !(next instanceof Error) ? next : initialDefs })),
  };
  const serverTools = new Map<string, Tool[]>();
  serverTools.set(
    "srv",
    initialDefs.map((d) => wrapMcpTool("srv", d, client as any, entry)),
  );
  if (next instanceof Error) client.listTools = vi.fn(async () => { throw next; });
  const fireChanged = vi.fn();
  const onWarn = vi.fn();
  const refresh = makeServerRefresher({ serverName: "srv", entry, client: client as any, serverTools, fireChanged, onWarn });
  return { serverTools, client, fireChanged, onWarn, refresh };
}

beforeEach(() => clearMcpApprovals());
afterEach(() => clearMcpApprovals());

describe("makeServerRefresher", () => {
  it("重拉 diff：+新 -旧，fireChanged 与变更告警各一次", async () => {
    const { refresh, serverTools, fireChanged, onWarn } = makeEnv(
      [{ name: "a" }, { name: "b" }],
      [{ name: "b" }, { name: "c" }],
    );
    const diff = await refresh();
    expect(diff.added).toEqual(["mcp_srv_c"]);
    expect(diff.removed).toEqual(["mcp_srv_a"]);
    expect(serverTools.get("srv")!.map((t) => t.name).sort()).toEqual(["mcp_srv_b", "mcp_srv_c"]);
    expect(fireChanged).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("已变更"));
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("mcp_srv_c"));
  });

  it("无变更 → 不 fireChanged 不告警", async () => {
    const { refresh, fireChanged, onWarn } = makeEnv(
      [{ name: "a" }, { name: "b" }],
      [{ name: "a" }, { name: "b" }],
    );
    const diff = await refresh();
    expect(diff).toEqual({ added: [], removed: [] });
    expect(fireChanged).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("listTools 抛错 → 保留旧工具、空 diff、失败告警", async () => {
    const { refresh, serverTools, fireChanged, onWarn } = makeEnv([{ name: "a" }], new Error("boom"));
    const diff = await refresh();
    expect(diff).toEqual({ added: [], removed: [] });
    expect(serverTools.get("srv")!.map((t) => t.name)).toEqual(["mcp_srv_a"]);
    expect(fireChanged).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("刷新失败"));
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("重 wrap 的新工具带审批登记（annotations 消费）", async () => {
    const { refresh, serverTools } = makeEnv([{ name: "a" }], [{ name: "x", annotations: { destructiveHint: true } }]);
    await refresh();
    const { getMcpApproval } = await import("../../src/engine/mcp");
    expect(getMcpApproval("mcp_srv_x")).toBe("ask");
    expect(serverTools.get("srv")).toHaveLength(1);
  });
});

describe("registerListChanged", () => {
  it("订阅 notifications/tools/list_changed，触发时执行刷新", async () => {
    let handler: (() => Promise<void>) | null = null;
    const client = {
      setNotificationHandler: (schema: any, h: any) => {
        // 校验订阅的是 tools list_changed（schema 解析 method）
        const method = schema?.safeParse?.({ method: "notifications/tools/list_changed" });
        if (method?.success) handler = h;
      },
    };
    const refresh = vi.fn(async () => {});
    registerListChanged(client as any, refresh);
    expect(handler).not.toBeNull();
    await handler!();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("client 不支持 setNotificationHandler → 静默不抛", () => {
    expect(() => registerListChanged({} as any, async () => {})).not.toThrow();
  });
});
