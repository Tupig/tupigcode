/**
 * E18 MCP 双重审批：全局开关 + server/tool 白名单 + readOnlyHint 分级。对应 issue #10。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig, connectMcpServers, getMcpApproval, clearMcpApprovals, type McpConnection } from "../../src/engine/mcp";
import { canUseTool } from "../../src/services/permissions";
import type { ToolPermissionContext } from "../../src/state/AppState";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.mjs");

let dir: string;
let conn: McpConnection | null = null;

function ctx(mode: ToolPermissionContext["mode"] = "default"): ToolPermissionContext {
  return { mode, alwaysAllowRules: new Map(), alwaysAskRules: new Map(), alwaysDenyRules: new Map() };
}

function writeMcpJson(workDir: string, servers: Record<string, any>) {
  fs.mkdirSync(path.join(workDir, ".tupigcode"), { recursive: true });
  fs.writeFileSync(path.join(workDir, ".tupigcode", "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-"));
  clearMcpApprovals();
});

afterEach(() => {
  delete process.env.TUPIG_MCP_APPROVAL;
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await conn?.close();
});

describe("mcp.json approval 字段解析", () => {
  it("解析 server 级 approval 与 per-tool tools 白名单", () => {
    writeMcpJson(dir, {
      demo: { command: "node", args: [FIXTURE], approval: "allow", tools: { touch: "deny" } },
    });
    const cfg = loadMcpConfig(dir);
    expect(cfg?.mcpServers?.["demo"]?.approval).toBe("allow");
    expect(cfg?.mcpServers?.["demo"]?.tools?.["touch"]).toBe("deny");
  });
  it("无 approval 字段 → undefined（兼容旧配置）", () => {
    writeMcpJson(dir, { demo: { command: "node", args: [FIXTURE] } });
    const cfg = loadMcpConfig(dir);
    expect(cfg?.mcpServers?.["demo"]?.approval).toBeUndefined();
  });
});

describe("连接后审批表注册（集成）", () => {
  it("server 级 approval 覆盖全工具；per-tool 覆盖 server 级；未配置 = default", async () => {
    writeMcpJson(dir, {
      demo: { command: "node", args: [FIXTURE], approval: "allow", tools: { touch: "deny" } },
      bare: { command: "node", args: [FIXTURE] },
    });
    conn = await connectMcpServers(dir);
    expect(getMcpApproval("mcp_demo_touch")).toBe("deny"); // per-tool 覆盖
    expect(getMcpApproval("mcp_demo_peek")).toBe("allow"); // server 级
    expect(getMcpApproval("mcp_bare_echo")).toBe("default"); // 未配置
    expect(getMcpApproval("NotMcpTool")).toBeUndefined(); // 非 MCP 工具
  });
});

describe("canUseTool × MCP 审批", () => {
  it("白名单 allow：可写 MCP 工具直接放行（现状是 ask）", async () => {
    const tool = { name: "mcp_x_touch", isReadOnly: () => false } as any;
    const r = await canUseTool("mcp_x_touch", {}, tool, ctx());
    expect(r.behavior).toBe("ask"); // 基线：无注册走通用链
    // 注册后的行为在下方集成用例覆盖；此处先固化"未注册 = 现状"
    expect(getMcpApproval("mcp_x_touch")).toBeUndefined();
  });

  it("注册 allow → 放行；注册 deny → 阻断；注册 ask → 强制问（盖过只读）", async () => {
    writeMcpJson(dir, { demo: { command: "node", args: [FIXTURE], approval: "allow", tools: { touch: "deny", peek: "ask" } } });
    conn = await connectMcpServers(dir);
    const peek = conn.tools.find((t) => t.name === "mcp_demo_peek")!;
    const touch = conn.tools.find((t) => t.name === "mcp_demo_touch")!;
    expect(touch).toBeTruthy();

    expect((await canUseTool("mcp_demo_touch", {}, touch, ctx())).behavior).toBe("deny");
    expect((await canUseTool("mcp_demo_peek", {}, peek, ctx())).behavior).toBe("ask");
    expect((await canUseTool("mcp_demo_echo", {}, conn.tools.find((t) => t.name === "mcp_demo_echo")!, ctx())).behavior)
      .toBe("allow"); // server 级 allow 覆盖（echo 无 per-tool 配置）
  });

  it("未配置 approval → 完全沿用现状分级：只读 allow / 可写 ask", async () => {
    writeMcpJson(dir, { bare: { command: "node", args: [FIXTURE] } });
    conn = await connectMcpServers(dir);
    const peek = conn.tools.find((t) => t.name === "mcp_bare_peek")!;
    const touch = conn.tools.find((t) => t.name === "mcp_bare_touch")!;
    expect((await canUseTool("mcp_bare_peek", {}, peek, ctx())).behavior).toBe("allow");
    expect((await canUseTool("mcp_bare_touch", {}, touch, ctx())).behavior).toBe("ask");
  });

  it("TUPIG_MCP_APPROVAL=off → 未配置的可写 MCP 工具放行", async () => {
    process.env.TUPIG_MCP_APPROVAL = "off";
    writeMcpJson(dir, { bare: { command: "node", args: [FIXTURE] } });
    conn = await connectMcpServers(dir);
    const touch = conn.tools.find((t) => t.name === "mcp_bare_touch")!;
    expect((await canUseTool("mcp_bare_touch", {}, touch, ctx())).behavior).toBe("allow");
  });

  it("TUPIG_MCP_APPROVAL=ask → 未配置的只读 MCP 工具也强制问", async () => {
    process.env.TUPIG_MCP_APPROVAL = "ask";
    writeMcpJson(dir, { bare: { command: "node", args: [FIXTURE] } });
    conn = await connectMcpServers(dir);
    const peek = conn.tools.find((t) => t.name === "mcp_bare_peek")!;
    expect((await canUseTool("mcp_bare_peek", {}, peek, ctx())).behavior).toBe("ask");
  });

  it("env 开关不误伤非 MCP 工具", async () => {
    process.env.TUPIG_MCP_APPROVAL = "off";
    const bash = { name: "Bash", isReadOnly: (i: any) => String(i.command).startsWith("ls"), isDestructive: () => false } as any;
    expect((await canUseTool("Bash", { command: "rm -rf /" }, bash, ctx())).behavior).toBe("ask");
  });

  it("通用 alwaysDeny 规则优先于 MCP 白名单 allow；bypassPermissions 仍最高", async () => {
    writeMcpJson(dir, { demo: { command: "node", args: [FIXTURE], approval: "allow" } });
    conn = await connectMcpServers(dir);
    const touch = conn.tools.find((t) => t.name === "mcp_demo_touch")!;

    const denyCtx = ctx();
    denyCtx.alwaysDenyRules.set("rules", [{ pattern: "mcp_demo_touch", source: "user" }]);
    expect((await canUseTool("mcp_demo_touch", {}, touch, denyCtx)).behavior).toBe("deny");

    expect((await canUseTool("mcp_demo_touch", {}, touch, ctx("bypassPermissions"))).behavior).toBe("allow");
  });

  it("plan 模式下可写 MCP 工具仍 deny（MCP 分支不越过 plan）", async () => {
    writeMcpJson(dir, { demo: { command: "node", args: [FIXTURE], approval: "allow" } });
    conn = await connectMcpServers(dir);
    const touch = conn.tools.find((t) => t.name === "mcp_demo_touch")!;
    expect((await canUseTool("mcp_demo_touch", {}, touch, ctx("plan"))).behavior).toBe("deny");
  });

  it("tool.checkPermissions 与审批表对齐（防御一致性）", async () => {
    writeMcpJson(dir, { demo: { command: "node", args: [FIXTURE], tools: { touch: "deny", peek: "ask" } } });
    conn = await connectMcpServers(dir);
    const touch = conn.tools.find((t) => t.name === "mcp_demo_touch")!;
    const peek = conn.tools.find((t) => t.name === "mcp_demo_peek")!;
    expect((await touch.checkPermissions({}, null as any)).behavior).toBe("deny");
    expect((await peek.checkPermissions({}, null as any)).behavior).toBe("ask");
  });
});
