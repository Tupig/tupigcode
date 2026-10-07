/**
 * E61 MCP ToolAnnotations 全量接入（issue #58）
 *
 * - destructiveHint=true 且非 readOnly → approval 升 ask（allow 被覆盖、deny 优先）
 * - annotations 缺省 / destructiveHint=false / readOnlyHint=true → 不强制
 * - title 进 description 前缀
 * - permissions.canUseTool：升 ask 后走 mcp 审批 ask 分支
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { wrapMcpTool, getMcpApproval, clearMcpApprovals, type McpServerEntry } from "../../src/engine/mcp";

const fakeClient = () => ({
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
}) as any;

const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  command: "noop",
  approval: "allow",
  ...over,
});

function ctx(mode = "default"): any {
  return { mode, alwaysAllowRules: new Map(), alwaysAskRules: new Map(), alwaysDenyRules: new Map() };
}

describe("wrapMcpTool annotations", () => {
  beforeEach(() => clearMcpApprovals());
  afterEach(() => clearMcpApprovals());

  it("destructiveHint=true 非只读 → 表内升 ask（覆盖 allow）", () => {
    const tool = wrapMcpTool("s", { name: "del", annotations: { destructiveHint: true } }, fakeClient(), entry());
    expect(getMcpApproval(tool.name)).toBe("ask");
  });

  it("destructiveHint=true 但 deny → deny 优先", () => {
    const tool = wrapMcpTool("s", { name: "del", annotations: { destructiveHint: true } }, fakeClient(), entry({ approval: "deny" }));
    expect(getMcpApproval(tool.name)).toBe("deny");
  });

  it("readOnlyHint=true → 不强制（只读不破坏）", () => {
    const tool = wrapMcpTool("s", { name: "ls", annotations: { readOnlyHint: true, destructiveHint: true } }, fakeClient(), entry());
    expect(getMcpApproval(tool.name)).toBe("allow");
    expect(tool.isReadOnly({})).toBe(true);
  });

  it("annotations 缺省 / destructiveHint=false → 保持原审批", () => {
    const t1 = wrapMcpTool("s", { name: "plain" }, fakeClient(), entry());
    expect(getMcpApproval(t1.name)).toBe("allow");
    const t2 = wrapMcpTool("s", { name: "safe", annotations: { destructiveHint: false } }, fakeClient(), entry());
    expect(getMcpApproval(t2.name)).toBe("allow");
  });

  it("per-tool 配置为 ask 仍为 ask；per-tool allow + destructive → ask", () => {
    const t1 = wrapMcpTool("s", { name: "a" }, fakeClient(), entry({ tools: { a: "ask" } }));
    expect(getMcpApproval(t1.name)).toBe("ask");
    const t2 = wrapMcpTool("s", { name: "b", annotations: { destructiveHint: true } }, fakeClient(), entry({ tools: { b: "allow" } }));
    expect(getMcpApproval(t2.name)).toBe("ask");
  });

  it("title 进 description 前缀", () => {
    const tool = wrapMcpTool("s", { name: "t", title: "删除文件", description: "rm things" }, fakeClient(), entry());
    expect(tool.description({} as any)).toContain("删除文件");
    expect(tool.description({} as any)).toContain("rm things");
  });
});

describe("canUseTool 与 annotations 联动", () => {
  beforeEach(() => clearMcpApprovals());
  afterEach(() => {
    clearMcpApprovals();
    delete process.env.TUPIG_MCP_APPROVAL;
  });

  it("升 ask 后 mcp 审批分支返回 ask（allow 被覆盖）", async () => {
    const { canUseTool } = await import("../../src/services/permissions");
    const tool = wrapMcpTool("s", { name: "del", annotations: { destructiveHint: true } }, fakeClient(), entry());
    const r = await canUseTool(tool.name, {}, tool, ctx());
    expect(r.behavior).toBe("ask");
  }, 10_000);

  it("TUPIG_MCP_APPROVAL=off 仍可逃生（全局 off 优先）", async () => {
    process.env.TUPIG_MCP_APPROVAL = "off";
    const { canUseTool } = await import("../../src/services/permissions");
    const tool = wrapMcpTool("s", { name: "del", annotations: { destructiveHint: true } }, fakeClient(), entry());
    const r = await canUseTool(tool.name, {}, tool, ctx());
    expect(r.behavior).toBe("allow");
  }, 10_000);
});
