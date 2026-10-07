/**
 * E64 MCP includeTools/excludeTools 过滤（issue #61）
 *
 * - exclude 优先：命中即剔除（即使同时在 include）
 * - 只配 include → 只留名单内；均未配 → 全量
 * - makeServerRefresher 重拉走同一过滤
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  filterMcpToolDefs,
  makeServerRefresher,
  clearMcpApprovals,
  type McpServerEntry,
  type McpToolDef,
} from "../../src/engine/mcp";
import type { Tool } from "../../src/engine/Tool";

const defs: McpToolDef[] = [{ name: "read" }, { name: "write" }, { name: "admin" }];
const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({ command: "noop", ...over });

beforeEach(() => clearMcpApprovals());
afterEach(() => clearMcpApprovals());

describe("filterMcpToolDefs", () => {
  it("均未配 → 全量", () => {
    expect(filterMcpToolDefs(defs, entry())).toHaveLength(3);
  });

  it("exclude 剔除命中项", () => {
    const r = filterMcpToolDefs(defs, entry({ excludeTools: ["admin", "write"] }));
    expect(r.map((d) => d.name)).toEqual(["read"]);
  });

  it("只配 include → 只留名单内", () => {
    const r = filterMcpToolDefs(defs, entry({ includeTools: ["read", "admin"] }));
    expect(r.map((d) => d.name)).toEqual(["read", "admin"]);
  });

  it("exclude 优先于 include（同时配置 → 剔除）", () => {
    const r = filterMcpToolDefs(defs, entry({ includeTools: ["read", "write"], excludeTools: ["write"] }));
    expect(r.map((d) => d.name)).toEqual(["read"]);
  });

  it("空名单等价未配置 include（空数组不裁剪）", () => {
    expect(filterMcpToolDefs(defs, entry({ includeTools: [] }))).toHaveLength(3);
  });
});

describe("makeServerRefresher 走同一过滤", () => {
  it("重拉后 exclude 的工具不进 serverTools", async () => {
    const serverTools = new Map<string, Tool[]>();
    serverTools.set("srv", [{ name: "mcp_srv_read" }, { name: "mcp_srv_admin" }] as Tool[]);
    const client = {
      callTool: async () => ({ content: [] }),
      listTools: vi.fn(async () => ({ tools: [{ name: "read" }, { name: "admin" }] })),
    };
    const fireChanged = vi.fn();
    const refresh = makeServerRefresher({
      serverName: "srv",
      entry: entry({ excludeTools: ["admin"] }),
      client: client as any,
      serverTools,
      fireChanged,
      onWarn: vi.fn(),
    });
    const diff = await refresh();
    expect(serverTools.get("srv")!.map((t) => t.name)).toEqual(["mcp_srv_read"]);
    expect(diff.removed).toEqual(["mcp_srv_admin"]); // 过滤生效视为"移除"
    expect(fireChanged).toHaveBeenCalledTimes(1);
  });
});
