/**
 * E31 权限「总是允许」持久化（issue #28）
 * 模式推导 / 写入去重 / 持久匹配 / 损坏回退 / canUseTool 集成 /
 * 敏感路径与自修改面仍优先
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, accessSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deriveAlwaysPattern,
  addAlwaysAllow,
  loadAlwaysAllow,
  clearAlwaysAllow,
  evaluatePersistentAllow,
  APPROVAL_FILE,
} from "../../src/services/approval-store";
import { canUseTool } from "../../src/services/permissions";
import { promptUserDecision } from "../../src/services/permissions";
import { appStore } from "../../src/state/AppState";
import type { ToolPermissionContext } from "../../src/state/AppState";

let dir = "";
const originalWorkDir = appStore.getState().workDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approval-"));
  appStore.setState((s) => ({ ...s, workDir: dir }));
});
afterEach(() => {
  appStore.setState((s) => ({ ...s, workDir: originalWorkDir }));
  rmSync(dir, { recursive: true, force: true });
});

function ctx(mode: ToolPermissionContext["mode"] = "default"): ToolPermissionContext {
  return { mode, alwaysAllowRules: new Map(), alwaysAskRules: new Map(), alwaysDenyRules: new Map() };
}

describe("deriveAlwaysPattern 模式推导", () => {
  it("多词 Bash → 前缀通配 Bash(npm *)", () => {
    expect(deriveAlwaysPattern("Bash", { command: "npm test --run" })).toBe("Bash(npm *)");
    expect(deriveAlwaysPattern("Bash", { command: "git status --short" })).toBe("Bash(git *)");
  });

  it("单词 Bash → 工具级 Bash", () => {
    expect(deriveAlwaysPattern("Bash", { command: "ls" })).toBe("Bash");
  });

  it("Write/Edit → 工具级（敏感路径与自修改面仍会在 canUseTool 兜底）", () => {
    expect(deriveAlwaysPattern("Write", { file_path: "/repo/a.ts" })).toBe("Write");
    expect(deriveAlwaysPattern("Edit", { file_path: "/repo/a.ts" })).toBe("Edit");
  });

  it("其他工具 → 工具级", () => {
    expect(deriveAlwaysPattern("Glob", { pattern: "**/*.ts" })).toBe("Glob");
  });
});

describe("持久化读写", () => {
  it("写入 + 读取往返", () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    const list = loadAlwaysAllow(dir);
    expect(list).toHaveLength(1);
    expect(list[0].pattern).toBe("Bash(npm *)");
    expect(list[0].source).toBe("user:always");
    expect(existsApproval(dir)).toBe(true);
  });

  it("重复写入去重", () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    addAlwaysAllow(dir, "Bash(npm *)");
    expect(loadAlwaysAllow(dir)).toHaveLength(1);
  });

  it("损坏文件 → 空数组不抛", () => {
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, APPROVAL_FILE), "{oops");
    expect(loadAlwaysAllow(dir)).toEqual([]);
  });

  it("clearAlwaysAllow 清空", () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    expect(clearAlwaysAllow(dir)).toBe(1);
    expect(loadAlwaysAllow(dir)).toHaveLength(0);
  });
});

describe("evaluatePersistentAllow 匹配", () => {
  it("前缀命中 → true；不同前缀 → false", () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    expect(evaluatePersistentAllow(dir, "Bash", { command: "npm run build" })).toBe(true);
    expect(evaluatePersistentAllow(dir, "Bash", { command: "cargo test" })).toBe(false);
  });

  it("工具级模式 → 任意输入命中", () => {
    addAlwaysAllow(dir, "Write");
    expect(evaluatePersistentAllow(dir, "Write", { file_path: "/repo/x.ts" })).toBe(true);
    expect(evaluatePersistentAllow(dir, "Edit", { file_path: "/repo/x.ts" })).toBe(false);
  });

  it("无记录 → false", () => {
    expect(evaluatePersistentAllow(dir, "Bash", { command: "ls" })).toBe(false);
  });
});

describe("canUseTool 集成", () => {
  const bashTool = { name: "Bash", isReadOnly: () => false, isDestructive: () => false } as any;
  const writeTool = { name: "Write", isReadOnly: () => false, isDestructive: () => true } as any;

  it("持久 allow → 同前缀命令自动放行", async () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    const r = await canUseTool("Bash", { command: "npm test" }, bashTool, ctx());
    expect(r.behavior).toBe("allow");
  });

  it("不同前缀仍走原链（mutate 放行，危险命令 ask）", async () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    const r = await canUseTool("Bash", { command: "rm -rf /tmp/x" }, bashTool, ctx());
    expect(r.behavior).toBe("ask");
  });

  it("敏感路径写：持久 Write allow 也仍 deny（检查前移）", async () => {
    addAlwaysAllow(dir, "Write");
    const r = await canUseTool("Write", { file_path: "/etc/passwd", content: "x" }, writeTool, ctx());
    expect(r.behavior).toBe("deny");
  });

  it("自修改面：持久 allow 也仍 ask", async () => {
    addAlwaysAllow(dir, "Write");
    const r = await canUseTool("Write", { file_path: join(dir, ".tupigcode", "skills", "x", "SKILL.md"), content: "y" }, writeTool, ctx());
    expect(r.behavior).toBe("ask");
  });

  it("deny 规则优先于持久 allow", async () => {
    addAlwaysAllow(dir, "Bash(npm *)");
    const c = ctx();
    c.alwaysDenyRules.set("d", [{ pattern: "Bash(npm test)", source: "t" }]);
    const r = await canUseTool("Bash", { command: "npm test" }, bashTool, c);
    expect(r.behavior).toBe("deny");
  });
});

describe("promptUserDecision", () => {
  it("非 TTY → deny（与旧 promptUser 语义一致）", async () => {
    if (process.stdin.isTTY) return; // TTY 环境跳过
    const d = await promptUserDecision("Bash", { command: "ls" });
    expect(d).toBe("deny");
  });
});

function existsApproval(w: string): boolean {
  try {
    accessSync(join(w, APPROVAL_FILE));
    return true;
  } catch {
    return false;
  }
}
