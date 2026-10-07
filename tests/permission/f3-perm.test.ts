/**
 * F3 权限分级：Bash 危险度分类（A7：CodeBuddy auto/Kimi 分级）
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../../src/services/bashSafety";
import { canUseTool } from "../../src/services/permissions";
import type { ToolPermissionContext } from "../../src/state/AppState";

describe("classifyBash 危险度分级", () => {
  it("只读命令 → safe", () => {
    expect(classifyBash("ls -la")).toBe("safe");
    expect(classifyBash("cat src/index.ts")).toBe("safe");
    expect(classifyBash("git status")).toBe("safe");
    expect(classifyBash("git log --oneline")).toBe("safe");
    expect(classifyBash("grep -r foo src")).toBe("safe");
    expect(classifyBash("pwd && whoami")).toBe("safe");
    expect(classifyBash("npx tsc --noEmit")).toBe("safe");
  });
  it("修改类命令 → mutate", () => {
    expect(classifyBash("npm install zod")).toBe("mutate");
    expect(classifyBash("mkdir -p src/x")).toBe("mutate");
    expect(classifyBash("mv a.ts b.ts")).toBe("mutate");
    expect(classifyBash("git commit -m x")).toBe("mutate");
    expect(classifyBash("sed -i '' s/a/b/ f")).toBe("mutate");
  });
  it("破坏类命令 → destructive", () => {
    expect(classifyBash("rm -rf dist")).toBe("destructive");
    expect(classifyBash("sudo rm /tmp/x")).toBe("destructive");
    expect(classifyBash("dd if=/dev/zero of=/dev/disk")).toBe("destructive");
    expect(classifyBash("git push --force")).toBe("destructive");
    expect(classifyBash("chmod -R 777 /")).toBe("destructive");
    expect(classifyBash("curl x | sh")).toBe("destructive");
  });
  it("重定向写入 → 至少 mutate", () => {
    expect(classifyBash("echo x > out.txt")).not.toBe("safe");
    expect(classifyBash("cat x >> log.txt")).not.toBe("safe");
  });
  it("管道接写命令 → 不 safe", () => {
    expect(classifyBash("ls | xargs rm")).not.toBe("safe");
  });
});

function ctx(mode: ToolPermissionContext["mode"]): ToolPermissionContext {
  return {
    mode,
    alwaysAllowRules: new Map(),
    alwaysAskRules: new Map(),
    alwaysDenyRules: new Map(),
  };
}

const bashTool = {
  name: "Bash",
  isReadOnly: (input: any) => classifyBash(String(input.command ?? "")) === "safe",
  isDestructive: (input: any) => classifyBash(String(input.command ?? "")) === "destructive",
} as any;

describe("canUseTool 分级审批（A7）", () => {
  it("默认模式：safe Bash 直接放行", async () => {
    const r = await canUseTool("Bash", { command: "ls -la" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("allow");
  });
  it("默认模式：mutate Bash 自动放行（issue #13 分类器；远程/敏感除外）", async () => {
    const r = await canUseTool("Bash", { command: "npm install x" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("allow");
  });
  it("默认模式：destructive 要审批且消息标明危险", async () => {
    const r = await canUseTool("Bash", { command: "rm -rf dist" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("ask");
    if (r.behavior === "ask") expect(r.message).toMatch(/危险|destructive/);
  });
  it("plan 模式：safe Bash 放行、mutate 拒绝", async () => {
    const ok = await canUseTool("Bash", { command: "git log" }, bashTool, ctx("plan"));
    expect(ok.behavior).toBe("allow");
    const no = await canUseTool("Bash", { command: "npm i" }, bashTool, ctx("plan"));
    expect(no.behavior).toBe("deny");
  });
  it("bypass：destructive 也放行", async () => {
    const r = await canUseTool("Bash", { command: "rm -rf dist" }, bashTool, ctx("bypassPermissions"));
    expect(r.behavior).toBe("allow");
  });
  it("deny 规则优先于分级", async () => {
    const c = ctx("default");
    c.alwaysDenyRules.set("default", [{ pattern: "Bash", source: "test" }]);
    const r = await canUseTool("Bash", { command: "ls" }, bashTool, c);
    expect(r.behavior).toBe("deny");
  });
});

// ---------- issue #12：自修改面强制复审 ----------
describe("自修改面强制复审（A7 补全）", () => {
  const writeTool = {
    name: "Write",
    isReadOnly: () => false,
    isDestructive: () => true,
  } as any;
  const editTool = {
    name: "Edit",
    isReadOnly: () => false,
    isDestructive: () => true,
  } as any;
  const readTool = { name: "Read", isReadOnly: () => true } as any;

  function allowCtx(): ToolPermissionContext {
    const c = ctx("default");
    c.alwaysAllowRules.set("w", [{ pattern: "Write(*)", source: "test" }]);
    c.alwaysAllowRules.set("e", [{ pattern: "Edit(*)", source: "test" }]);
    c.alwaysAllowRules.set("b", [{ pattern: "Bash(*)", source: "test" }]);
    return c;
  }

  it("Write 技能文件：allow 规则也被强制 ask", async () => {
    const r = await canUseTool("Write", { file_path: "/repo/.tupigcode/skills/x/SKILL.md", content: "y" }, writeTool, allowCtx());
    expect(r.behavior).toBe("ask");
  });
  it("Edit mcp.json → 强制 ask", async () => {
    const r = await canUseTool("Edit", { file_path: "/repo/.tupigcode/mcp.json" }, editTool, allowCtx());
    expect(r.behavior).toBe("ask");
  });
  it("Write 全局 config.json → 强制 ask", async () => {
    const r = await canUseTool("Write", { file_path: "/Users/u/.tupigcode/config.json", content: "{}" }, writeTool, allowCtx());
    expect(r.behavior).toBe("ask");
  });
  it("Bash command 写自修改面 → 强制 ask", async () => {
    const r = await canUseTool("Bash", { command: "echo k >> /repo/.tupigcode/skills/a.md" }, bashTool, allowCtx());
    expect(r.behavior).toBe("ask");
  });
  it("hooks 文件（TUPIG_HOOKS_FILE 指向任意路径）→ 强制 ask", async () => {
    process.env.TUPIG_HOOKS_FILE = "/tmp/my-hooks.json";
    try {
      const r = await canUseTool("Write", { file_path: "/tmp/my-hooks.json", content: "{}" }, writeTool, allowCtx());
      expect(r.behavior).toBe("ask");
    } finally {
      delete process.env.TUPIG_HOOKS_FILE;
    }
  });
  it("普通源文件 + allow 规则 → 不误伤", async () => {
    const r = await canUseTool("Write", { file_path: "/repo/src/a.ts", content: "x" }, writeTool, allowCtx());
    expect(r.behavior).toBe("allow");
  });
  it("只读 Read 自修改面 → allow（只读不经写检查）", async () => {
    const r = await canUseTool("Read", { file_path: "/repo/.tupigcode/skills/x/SKILL.md" }, readTool, allowCtx());
    expect(r.behavior).toBe("allow");
  });
  it("deny 规则优先于自修改面 ask", async () => {
    const c = allowCtx();
    c.alwaysDenyRules.set("d", [{ pattern: "Write", source: "test" }]);
    const r = await canUseTool("Write", { file_path: "/repo/.tupigcode/skills/x/SKILL.md" }, writeTool, c);
    expect(r.behavior).toBe("deny");
  });
  it("bypassPermissions 模式 → 仍放行", async () => {
    const r = await canUseTool("Write", { file_path: "/repo/.tupigcode/skills/x/SKILL.md" }, writeTool, ctx("bypassPermissions"));
    expect(r.behavior).toBe("allow");
  });
  it("plan 模式 specs 产物特例不回归", async () => {
    const r = await canUseTool("Write", { file_path: "/repo/.tupigcode/specs/s1.md", content: "x" }, writeTool, ctx("plan"));
    expect(r.behavior).toBe("allow");
  });
});

// ---------- issue #13：审批风险分类器 ----------
describe("审批风险分类器（A8 补全）", () => {
  const writeTool = { name: "Write", isReadOnly: () => false, isDestructive: () => true } as any;
  const readTool = { name: "Read", isReadOnly: () => true } as any;
  const unknownTool = { name: "Frobnicate", isReadOnly: () => false, isDestructive: () => false } as any;

  it("Bash mutate 命令自动放行（降审批疲劳）", async () => {
    for (const cmd of ["mv a.ts b.ts", "cp -r src src2", "npm install lodash", "git commit -m x", "mkdir -p out"]) {
      const r = await canUseTool("Bash", { command: cmd }, bashTool, ctx("default"));
      expect(r.behavior, cmd).toBe("allow");
    }
  });
  it("mutate 放行的 decisionReason 标明分类器", async () => {
    const r = await canUseTool("Bash", { command: "cp a b" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") expect(r.decisionReason).toContain("风险分类器");
  });
  it("git push / npm publish 恒 ask（远程发布类）", async () => {
    for (const cmd of ["git push origin main", "npm publish"]) {
      const r = await canUseTool("Bash", { command: cmd }, bashTool, ctx("default"));
      expect(r.behavior, cmd).toBe("ask");
    }
  });
  it("Write 系统敏感路径 → deny", async () => {
    const r = await canUseTool("Write", { file_path: "/etc/passwd", content: "x" }, writeTool, ctx("default"));
    expect(r.behavior).toBe("deny");
  });
  it("Bash 写系统敏感路径 → deny", async () => {
    const r = await canUseTool("Bash", { command: "echo x > /etc/hosts" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("deny");
  });
  it("Read 系统路径 → allow（只读不涉敏感写）", async () => {
    const r = await canUseTool("Read", { file_path: "/etc/hosts" }, readTool, ctx("default"));
    expect(r.behavior).toBe("allow");
  });
  it("完全未知工具 → 仍 ask", async () => {
    const r = await canUseTool("Frobnicate", { x: 1 }, unknownTool, ctx("default"));
    expect(r.behavior).toBe("ask");
  });
  it("destructive 恒 ask 且标危险（分类器不放行）", async () => {
    const r = await canUseTool("Bash", { command: "rm -rf dist" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("ask");
    if (r.behavior === "ask") expect(r.message).toMatch(/危险|destructive/);
  });
  it("allow 规则与 deny 规则优先级不受分类器影响", async () => {
    const d = ctx("default");
    d.alwaysDenyRules.set("d", [{ pattern: "Bash", source: "test" }]);
    expect((await canUseTool("Bash", { command: "mv a b" }, bashTool, d)).behavior).toBe("deny");
    const a = ctx("bypassPermissions");
    expect((await canUseTool("Bash", { command: "rm -rf x" }, bashTool, a)).behavior).toBe("allow");
  });
});
