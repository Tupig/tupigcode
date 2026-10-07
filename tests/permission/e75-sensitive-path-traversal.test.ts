/**
 * e75: 敏感路径相对穿越防护（issue #87）
 *
 * SENSITIVE_PATH 边界集须认 `.`、`/` 前导（..../etc、//etc 等），
 * Write 面必须 resolve 后检测（与 isSelfModifyWrite 基线一致）。
 */
import { describe, expect, it } from "vitest";
import { canUseTool, touchesSensitivePath } from "../../src/services/permissions";
import { classifyBash } from "../../src/services/bashSafety";
import type { ToolPermissionContext } from "../../src/state/AppState";

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

const writeTool = {
  name: "Write",
  isReadOnly: () => false,
  isDestructive: () => true,
} as any;

describe("touchesSensitivePath 相对穿越检出（issue #87）", () => {
  it("相对穿越 / //前导 / $前导 → 命中", () => {
    expect(touchesSensitivePath("echo x > ../../../../../../etc/hosts")).toBe(true);
    expect(touchesSensitivePath("echo x > //etc/hosts")).toBe(true);
    expect(touchesSensitivePath("cat $PWD/../.ssh/id_rsa")).toBe(true);
    expect(touchesSensitivePath("echo p > ../../../usr/local/bin/evil")).toBe(true);
  });
  it("绝对路径回归保持命中", () => {
    expect(touchesSensitivePath("cat /etc/hosts")).toBe(true);
    expect(touchesSensitivePath("rm /System/Library/x")).toBe(true);
    expect(touchesSensitivePath("Write file_path=/etc/passwd")).toBe(true);
  });
  it("正常目标不误伤", () => {
    expect(touchesSensitivePath("echo hi > ./out.txt")).toBe(false);
    expect(touchesSensitivePath("echo hi > ../../etc2/x")).toBe(false); // /etc2 非 /etc
    expect(touchesSensitivePath("cat docs/etc-guide.md")).toBe(false);
  });
});

describe("canUseTool 穿越防线（issue #87）", () => {
  it("Bash mutate 相对穿越 → deny（修前自动 allow）", async () => {
    const cmd = "echo hi > ../../../../../../etc/hosts";
    expect(classifyBash(cmd)).toBe("mutate"); // 前提：确实走 mutate 分支
    const r = await canUseTool("Bash", { command: cmd }, bashTool, ctx("default"));
    expect(r.behavior).toBe("deny");
  });

  it("Bash 敏感穿越在 allow 规则下也 deny（前移防线语义）", async () => {
    const c = ctx("default");
    c.alwaysAllowRules.set("b", [{ pattern: "Bash(*)", source: "test" }]);
    const r = await canUseTool(
      "Bash",
      { command: "echo hi > ../../../.ssh/authorized_keys" },
      bashTool,
      c,
    );
    expect(r.behavior).toBe("deny");
  });

  it("Write 相对穿越 → deny（resolve 后命中）", async () => {
    const r = await canUseTool(
      "Write",
      { file_path: "../../../../../../etc/hosts", content: "x" },
      writeTool,
      ctx("default"),
    );
    expect(r.behavior).toBe("deny");
  });

  it("合法 mutate 相对写仍自动放行（回归）", async () => {
    const r = await canUseTool("Bash", { command: "echo hi > ./out.txt" }, bashTool, ctx("default"));
    expect(r.behavior).toBe("allow");
    const w = await canUseTool(
      "Write",
      { file_path: "src/new.ts", content: "x" },
      writeTool,
      ctx("default"),
    );
    expect(w.behavior).not.toBe("deny"); // 工作区普通写不进敏感防线（ask 或规则放行）
  });
});
