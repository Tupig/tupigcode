/**
 * E3 防卡死：doom loop 检测 + 工具执行超时 + 非 TTY 快速拒绝
 */
import { describe, expect, it } from "vitest";
import { createDoomDetector, withTimeout } from "../../src/engine/QueryEngine";

describe("doom loop 检测（A21）", () => {
  it("连续 3 次相同动作 → 触发", () => {
    const d = createDoomDetector(3);
    const sig = JSON.stringify({ name: "Read", input: { file_path: "a.ts" } });
    expect(d.feed(sig)).toBe(false);
    expect(d.feed(sig)).toBe(false);
    expect(d.feed(sig)).toBe(true);
  });
  it("不同动作不触发", () => {
    const d = createDoomDetector(3);
    expect(d.feed("A")).toBe(false);
    expect(d.feed("B")).toBe(false);
    expect(d.feed("C")).toBe(false);
    expect(d.feed("D")).toBe(false);
  });
  it("穿插新动作重置计数", () => {
    const d = createDoomDetector(3);
    d.feed("A"); d.feed("A");
    d.feed("B");
    expect(d.feed("A")).toBe(false);
    expect(d.feed("A")).toBe(false);
    expect(d.feed("A")).toBe(true);
  });
  it("reset 后重新计数", () => {
    const d = createDoomDetector(2);
    d.feed("A");
    expect(d.feed("A")).toBe(true);
    d.reset();
    expect(d.feed("A")).toBe(false);
  });
});

describe("withTimeout 工具执行超时", () => {
  it("超时 → 抛错，不永久挂", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 30, "测试工具"),
    ).rejects.toThrow(/测试工具.*超时/);
  });
  it("正常完成 → 原样返回", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "t")).resolves.toBe(42);
  });
  it("快速 reject → 原样抛出", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "t")).rejects.toThrow("boom");
  });
});
