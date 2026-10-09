/**
 * E29 hook 生命周期事件补齐（issue #26）
 * SessionStart/Stop/PreCompact/PostCompact 触发 / source matcher 过滤 /
 * 失败不阻塞 / 端到端 SessionStart+Stop 各触发一次
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HookSystem, type HookContext, type HookEvent } from "../../src/engine/hooks";
import {
  fireSessionStart,
  fireStop,
  fireCompact,
  fireLifecycle,
} from "../../src/engine/hook-events";

const ctx = (over: Partial<HookContext> = {}): HookContext => ({
  turnNumber: 1,
  sessionId: "s-hook",
  ...over,
});

describe("生命周期事件触发", () => {
  let hs: HookSystem;
  let fired: Array<{ event: HookEvent; ctx: HookContext }>;

  beforeEach(() => {
    hs = new HookSystem();
    fired = [];
    for (const ev of ["SessionStart", "Stop", "PreCompact", "PostCompact"] as HookEvent[]) {
      hs.register({
        event: ev,
        handler: (c) => {
          fired.push({ event: ev, ctx: c });
        },
      });
    }
  });

  it("fireSessionStart / fireStop 各触发对应事件", async () => {
    await fireSessionStart(hs, ctx());
    await fireStop(hs, ctx({ output: "已完成" }));
    expect(fired.map((f) => f.event)).toEqual(["SessionStart", "Stop"]);
    expect(fired[1].ctx.output).toBe("已完成");
  });

  it("fireCompact source=auto/manual 触发 Pre+Post 且透传 source", async () => {
    await fireCompact(hs, ctx(), "auto");
    expect(fired.map((f) => f.event)).toEqual(["PreCompact", "PostCompact"]);
    expect(fired[0].ctx.source).toBe("auto");
    expect(fired[1].ctx.source).toBe("auto");

    fired.length = 0;
    await fireCompact(hs, ctx(), "manual");
    expect(fired[0].ctx.source).toBe("manual");
  });

  it("matcher.source 过滤：只注册 auto 的 handler 不吃 manual", async () => {
    const got: HookEvent[] = [];
    const hs2 = new HookSystem();
    hs2.register({ event: "PreCompact", matcher: { source: "auto" }, handler: () => { got.push("PreCompact"); } });
    await fireCompact(hs2, ctx(), "manual");
    expect(got).toHaveLength(0);
    await fireCompact(hs2, ctx(), "auto");
    expect(got).toEqual(["PreCompact"]);
  });

  it("handler 抛错 → fireLifecycle 隔离不上抛", async () => {
    const hs3 = new HookSystem();
    hs3.register({ event: "Stop", handler: () => { throw new Error("boom"); } });
    await expect(fireStop(hs3, ctx())).resolves.toBeUndefined();
  });

  it("空 matchers → 触发无异常", async () => {
    await expect(fireLifecycle(new HookSystem(), "Stop", ctx())).resolves.toBeUndefined();
  });
});

describe("端到端：mock 一轮触发 SessionStart + Stop", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("query() 生命期各触发一次（20s 限时）", async () => {
    process.env.TUPIG_MOCK = "1";
    const { query } = await import("../../src/engine/QueryEngine");
    const { hookSystem } = await import("../../src/engine/hooks");
    const fired: HookEvent[] = [];
    hookSystem.register({ event: "SessionStart", handler: () => { fired.push("SessionStart"); } });
    hookSystem.register({ event: "Stop", handler: () => { fired.push("Stop"); } });
    try {
      let result: any = null;
      const iter = query({ prompt: "列 src", options: { cwd: process.cwd(), model: "mock" } });
      for await (const msg of iter as any) {
        if (msg.type === "result") result = msg;
      }
      expect(result?.subtype).toBe("success");
      expect(fired.filter((e) => e === "SessionStart")).toHaveLength(1);
      expect(fired.filter((e) => e === "Stop")).toHaveLength(1);
    } finally {
      hookSystem.clear();
    }
  }, 20_000);
});
