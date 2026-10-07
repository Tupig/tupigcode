/**
 * E28 重试抖动 + 总预算上限（issue #25）
 * 退避带抖动区间 / 预算超限即停 / 401 立即抛 / 退避封顶
 */
import { describe, it, expect } from "vitest";
import { computeBackoffMs, callWithRetry } from "../../src/services/api";

describe("computeBackoffMs 抖动退避", () => {
  it("full jitter：落在 [0, min(cap, base*2^i)] 区间内", () => {
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 20; k++) {
        const ms = computeBackoffMs(i, { base: 1000, cap: 10_000 });
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(Math.min(10_000, 1000 * 2 ** i));
      }
    }
  });

  it("封顶：i=10 也不超过 cap", () => {
    for (let k = 0; k < 20; k++) {
      expect(computeBackoffMs(10, { base: 1000, cap: 10_000 })).toBeLessThanOrEqual(10_000);
    }
  });

  it("抖动确有随机性（20 次内出现两个不同值）", () => {
    const vals = new Set(Array.from({ length: 20 }, () => computeBackoffMs(3)));
    expect(vals.size).toBeGreaterThan(1);
  });
});

describe("callWithRetry 预算与认证", () => {
  it("瞬时失败后成功 → 返回结果", async () => {
    let n = 0;
    const r = await callWithRetry(async () => {
      n++;
      if (n < 2) throw new Error("429 rate limit");
      return "ok";
    });
    expect(r).toBe("ok");
    expect(n).toBe(2);
  });

  it("401 立即抛，不重试", async () => {
    let n = 0;
    await expect(
      callWithRetry(async () => {
        n++;
        throw new Error("401 unauthorized");
      }),
    ).rejects.toThrow("401");
    expect(n).toBe(1);
  });

  it("超预算（TUPIG_RETRY_BUDGET_MS=0）→ 第一次失败即停", async () => {
    process.env.TUPIG_RETRY_BUDGET_MS = "0";
    try {
      let n = 0;
      await expect(
        callWithRetry(async () => {
          n++;
          throw new Error("529 overloaded");
        }),
      ).rejects.toThrow("529");
      expect(n).toBe(1);
    } finally {
      delete process.env.TUPIG_RETRY_BUDGET_MS;
    }
  });

  it("用尽重试次数 → 抛最后错误", async () => {
    let n = 0;
    await expect(
      callWithRetry(async () => {
        n++;
        throw new Error(`boom ${n}`);
      }),
    ).rejects.toThrow("boom");
    expect(n).toBe(4); // MAX_RETRIES=3 → 1+3 次
  });
});
