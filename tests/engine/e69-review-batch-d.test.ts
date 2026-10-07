/**
 * E69 D 批深度审查（#58-#62）
 *
 * 审查点 1（D-1，#59）：list_changed 重拉后，**同名但 signature 变更**的工具
 *   （description/inputSchema/annotations/title）也算变更，必须 fireChanged 让
 *   外部工具集换新 wrap——否则 readOnlyHint true→false 的变更后旧 Tool 仍免审。
 * 审查点 2（D-3，#60）：同一 server 的 transport.onclose 可能被连续/并发触发，
 *   重连循环必须单飞——重复触发被拒绝，直到前一个循环结束才可再次获取。
 */
import { describe, expect, it, beforeAll } from "vitest";
import { makeServerRefresher, wrapMcpTool, type McpToolDef } from "../../src/engine/mcp";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

const entry = { command: "noop" } as any;

function def(name: string, extra: Partial<McpToolDef> = {}): McpToolDef {
  return { name, description: "d", ...extra };
}

describe("审查点 1：同名 signature 变更也触发 fireChanged（D-1）", () => {
  function setup(oldDefs: McpToolDef[], newDefs: McpToolDef[]) {
    const client = {
      callTool: async () => ({ content: [] }),
      listTools: async () => ({ tools: newDefs }),
    };
    const fireChanged = vi();
    const oldTools = oldDefs.map((d) => wrapMcpTool("s", d, client as any, entry));
    const serverTools = new Map<string, any[]>([["s", oldTools]]);
    const refresh = makeServerRefresher({
      serverName: "s",
      entry,
      client: client as any,
      serverTools,
      fireChanged,
    });
    return { refresh, fireChanged, serverTools };
  }
  const vi = () => {
    const f: any = () => { f.calls++; };
    f.calls = 0;
    return f;
  };

  it("同名工具 inputSchema 变更 → fireChanged（外部需换新 wrap）", async () => {
    const { refresh, fireChanged } = setup(
      [def("A", { inputSchema: { type: "object", properties: { x: { type: "string" } } } })],
      [def("A", { inputSchema: { type: "object", properties: { y: { type: "number" } } } })],
    );
    await refresh();
    expect(fireChanged.calls).toBeGreaterThan(0);
  });

  it("同名工具 annotations.readOnlyHint true→false → fireChanged（免审面变化）", async () => {
    const { refresh, fireChanged } = setup(
      [def("B", { annotations: { readOnlyHint: true } })],
      [def("B", { annotations: { readOnlyHint: false } })],
    );
    await refresh();
    expect(fireChanged.calls).toBeGreaterThan(0);
  });

  it("同名且 signature 一致 → 不 fireChanged", async () => {
    const { refresh, fireChanged } = setup([def("C")], [def("C")]);
    await refresh();
    expect(fireChanged.calls).toBe(0);
  });

  it("重拉后 serverTools 内已是新 signature 的 wrap（无论是否 fire）", async () => {
    const { refresh, serverTools } = setup(
      [def("D", { description: "old" })],
      [def("D", { description: "new" })],
    );
    await refresh();
    const wrapped: any[] = serverTools.get("s")!;
    expect(wrapped[0].description()).toContain("new");
    expect(wrapped[0].description()).not.toContain("old");
  });
});

describe("审查点 2：重连循环单飞守卫（D-3）", () => {
  it("同一 key 重复获取被拒绝，释放后可再次获取", async () => {
    const { createReconnectGuard } = await import("../../src/engine/mcp");
    const guard = createReconnectGuard();
    expect(guard.acquire("s1")).toBe(true);
    expect(guard.acquire("s1")).toBe(false); // 重入拒绝
    expect(guard.acquire("s2")).toBe(true); // 不同 server 不受影响
    guard.release("s1");
    expect(guard.acquire("s1")).toBe(true); // 释放后可重连
  });

  it("并发触发同一 key 只有第一个成功", async () => {
    const { createReconnectGuard } = await import("../../src/engine/mcp");
    const guard = createReconnectGuard();
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        await Promise.resolve();
        return guard.acquire("srv");
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
