/**
 * E45 ModeChange 模式切换 hook（issue #42）
 * 切换触发一次带 modeFrom/To / 不切换不触发 / matcher modeTo 过滤 / 吞异常
 */
import { describe, it, expect, afterEach } from "vitest";
import { HookSystem, type HookContext } from "../../src/engine/hooks";
import { fireModeChange } from "../../src/engine/hookEvents";

function base(): HookContext {
  return { turnNumber: 0, sessionId: "s-mode" };
}

describe("fireModeChange", () => {
  it("from≠to → 触发一次，带 modeFrom/modeTo", async () => {
    const hs = new HookSystem();
    const seen: HookContext[] = [];
    hs.register({ event: "ModeChange", handler: (c) => { seen.push(c); } });
    await fireModeChange(hs, "act", "plan", base());
    expect(seen).toHaveLength(1);
    expect(seen[0].modeFrom).toBe("act");
    expect(seen[0].modeTo).toBe("plan");
  });

  it("from=to → 不触发（无切换）", async () => {
    const hs = new HookSystem();
    let fired = 0;
    hs.register({ event: "ModeChange", handler: () => { fired++; } });
    await fireModeChange(hs, "plan", "plan", base());
    expect(fired).toBe(0);
  });

  it("matcher 可按 modeTo 过滤", async () => {
    const hs = new HookSystem();
    const fired: string[] = [];
    hs.register({ event: "ModeChange", matcher: { modeTo: "act" }, handler: (c) => { fired.push(c.modeTo!); } });
    await fireModeChange(hs, "plan", "act", base());
    await fireModeChange(hs, "act", "plan", base());
    expect(fired).toEqual(["act"]);
  });

  it("触发器抛异常 → 静默隔离", async () => {
    const hs = new HookSystem();
    hs.register({ event: "ModeChange", handler: () => { throw new Error("boom"); } });
    await expect(fireModeChange(hs, "act", "plan", base())).resolves.toBeUndefined();
  });
});

describe("mock 端到端：/plan 与 /act 切换触发", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("/plan：act→plan 触发；初始同模式的 /act 不触发", async () => {
    process.env.TUPIG_MOCK = "1";
    const { query } = await import("../../src/engine/QueryEngine");
    const { hookSystem } = await import("../../src/engine/hooks");
    const fired: Array<[string | undefined, string | undefined]> = [];
    hookSystem.register({ event: "ModeChange", handler: (c) => { fired.push([c.modeFrom, c.modeTo]); } });
    try {
      // 默认 initialMode=act → /plan 切换
      const it1 = query({ prompt: "/plan", options: { cwd: process.cwd(), model: "mock" } });
      for await (const _ of it1 as any) { /* drain */ }
      expect(fired).toEqual([["act", "plan"]]);

      // initialMode=act → /act 无切换，不触发
      const it2 = query({ prompt: "/act", options: { cwd: process.cwd(), model: "mock", initialMode: "act" } });
      for await (const _ of it2 as any) { /* drain */ }
      expect(fired).toHaveLength(1);

      // initialMode=plan → /act 切换
      const it3 = query({ prompt: "/act", options: { cwd: process.cwd(), model: "mock", initialMode: "plan" } });
      for await (const _ of it3 as any) { /* drain */ }
      expect(fired).toEqual([["act", "plan"], ["plan", "act"]]);
    } finally {
      hookSystem.clear();
    }
  }, 25_000);
});
