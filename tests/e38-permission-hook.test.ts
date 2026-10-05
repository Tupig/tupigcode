/**
 * E38 PermissionResult 权限落定 hook（issue #35）
 * 决策字段 / matcher 按 decision 过滤 / 异常隔离 / mock 端到端 allow 触发
 */
import { describe, it, expect, afterEach } from "vitest";
import { HookSystem, type HookContext } from "../src/engine/hooks";
import { firePermissionResult } from "../src/engine/hookEvents";

function base(): HookContext {
  return { turnNumber: 1, sessionId: "s-perm" };
}

describe("PermissionResult", () => {
  it("触发一次，带 decision + ruleSource + toolName", async () => {
    const hs = new HookSystem();
    const seen: HookContext[] = [];
    hs.register({ event: "PermissionResult", handler: (c) => { seen.push(c); } });
    await firePermissionResult(
      hs, { toolName: "Bash", decision: "allow", ruleSource: "规则:allow bash npm *", durationMs: 12 }, base(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].decision).toBe("allow");
    expect(seen[0].ruleSource).toBe("规则:allow bash npm *");
    expect(seen[0].toolName).toBe("Bash");
    expect(seen[0].durationMs).toBe(12);
  });

  it("matcher 可按 decision 过滤（deny 才触发）", async () => {
    const hs = new HookSystem();
    const fired: string[] = [];
    hs.register({ event: "PermissionResult", matcher: { decision: "deny" }, handler: (c) => { fired.push(c.decision!); } });
    await firePermissionResult(hs, { toolName: "Write", decision: "allow" }, base());
    await firePermissionResult(hs, { toolName: "Write", decision: "deny", ruleSource: "敏感路径" }, base());
    expect(fired).toEqual(["deny"]);
  });

  it("触发器抛异常 → 静默隔离", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PermissionResult", handler: () => { throw new Error("boom"); } });
    await expect(
      firePermissionResult(hs, { toolName: "Read", decision: "always" }, base()),
    ).resolves.toBeUndefined();
  });

  it("mock 端到端：只读工具放行后触发 allow", async () => {
    const originalEnv = { ...process.env };
    try {
      process.env.TUPIG_MOCK = "1";
      const { query } = await import("../src/engine/QueryEngine");
      const { hookSystem } = await import("../src/engine/hooks");
      const seen: HookContext[] = [];
      hookSystem.register({ event: "PermissionResult", handler: (c) => { seen.push(c); } });
      let result: any = null;
      const iter = query({ prompt: "读 README.md", options: { cwd: process.cwd(), model: "mock" } });
      for await (const msg of iter as any) {
        if (msg.type === "result") result = msg;
      }
      expect(result?.subtype).toBe("success");
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(["allow", "always"]).toContain(seen[0].decision);
      expect(seen[0].toolName).toBeTruthy();
    } finally {
      process.env = { ...originalEnv };
      const { hookSystem } = await import("../src/engine/hooks");
      hookSystem.clear();
    }
  }, 20_000);
});
