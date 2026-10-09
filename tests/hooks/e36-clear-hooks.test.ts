/**
 * E36 PreClear/PostClear hook（issue #33）
 * 顺序 Pre → 清空 → Post / 每事件一次 / 抛异常不影响清空 / 清空行为不变
 */
import { describe, it, expect } from "vitest";
import { HookSystem, type HookContext } from "../../src/engine/hooks";
import { runClearSequence } from "../../src/engine/hook-events";

function ctx(): HookContext {
  return { turnNumber: 0, sessionId: "s-clear" };
}

describe("PreClear / PostClear", () => {
  it("顺序：Pre → 清空动作 → Post，各触发一次", async () => {
    const hs = new HookSystem();
    const order: string[] = [];
    hs.register({ event: "PreClear", handler: () => { order.push("Pre"); } });
    hs.register({ event: "PostClear", handler: () => { order.push("Post"); } });
    await runClearSequence(hs, ctx, () => { order.push("reset"); });
    expect(order).toEqual(["Pre", "reset", "Post"]);
  });

  it("触发器抛异常 → 清空仍执行，Post 仍触发", async () => {
    const hs = new HookSystem();
    const order: string[] = [];
    hs.register({ event: "PreClear", handler: () => { order.push("Pre"); throw new Error("boom"); } });
    hs.register({ event: "PostClear", handler: () => { order.push("Post"); } });
    await runClearSequence(hs, ctx, () => { order.push("reset"); });
    expect(order).toEqual(["Pre", "reset", "Post"]);
  });

  it("无触发器 → reset 正常执行（清空行为不变）", async () => {
    const hs = new HookSystem();
    let reset = 0;
    await runClearSequence(hs, ctx, () => { reset++; });
    expect(reset).toBe(1);
  });

  it("reset 抛异常 → 原样上抛（清空失败不被 hook 忽略）", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PreClear", handler: () => {} });
    await expect(
      runClearSequence(hs, ctx, () => { throw new Error("reset-fail"); }),
    ).rejects.toThrow("reset-fail");
  });
});
