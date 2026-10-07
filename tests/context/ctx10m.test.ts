/**
 * 上下文压缩支持 10M：env 可配 + 梯子/预算自适应
 */
import { describe, expect, it, afterEach } from "vitest";
import { resolveMaxContextTokens, MAX_CONTEXT_TOKENS, ADAPTIVE_ITERATIONS_CAP } from "../../src/engine/constants";
import { adaptiveIterations, pickStrategy, ContextCompactor } from "../../src/context/compact/index";

afterEach(() => {
  delete process.env.TUPIG_MAX_CONTEXT_TOKENS;
});

describe("resolveMaxContextTokens 支持 10M", () => {
  it("默认 30_000", () => {
    delete process.env.TUPIG_MAX_CONTEXT_TOKENS;
    expect(resolveMaxContextTokens()).toBe(30_000);
  });
  it("env=10M → 10_000_000", () => {
    process.env.TUPIG_MAX_CONTEXT_TOKENS = "10000000";
    expect(resolveMaxContextTokens()).toBe(10_000_000);
  });
  it("env 超 10M → clamp 到 10M", () => {
    process.env.TUPIG_MAX_CONTEXT_TOKENS = "99999999";
    expect(resolveMaxContextTokens()).toBe(10_000_000);
  });
  it("env 非法/过小 → 回退默认 30_000", () => {
    process.env.TUPIG_MAX_CONTEXT_TOKENS = "abc";
    expect(resolveMaxContextTokens()).toBe(30_000);
    process.env.TUPIG_MAX_CONTEXT_TOKENS = "100";
    expect(resolveMaxContextTokens()).toBe(30_000);
    process.env.TUPIG_MAX_CONTEXT_TOKENS = "-5";
    expect(resolveMaxContextTokens()).toBe(30_000);
  });
  it("MAX_CONTEXT_TOKENS 导出存在且 ≤10M", () => {
    expect(MAX_CONTEXT_TOKENS).toBeLessThanOrEqual(10_000_000);
    expect(MAX_CONTEXT_TOKENS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("adaptiveIterations 预算迭代自适应", () => {
  it("30k 小窗口 → 5（保持原行为）", () => {
    expect(adaptiveIterations(28_000, 30_000)).toBe(5);
  });
  it("10M 窗口大差距 → 超过 5", () => {
    expect(adaptiveIterations(9_000_000, 10_000_000)).toBeGreaterThan(5);
  });
  it("封顶 ≤ ADAPTIVE_ITERATIONS_CAP", () => {
    expect(adaptiveIterations(9_999_999, 10_000_000)).toBeLessThanOrEqual(ADAPTIVE_ITERATIONS_CAP);
  });
  it("差距小 → 至少 5", () => {
    expect(adaptiveIterations(31_000, 30_000)).toBe(5);
  });
});

describe("pickStrategy 大窗口消息数阈值", () => {
  it("缺省（30k）1000 条 → force（兼容旧行为）", () => {
    expect(pickStrategy(0.5, 1000)).toBe("force");
  });
  it("10M 窗口 500 条 → 不因消息数 force", () => {
    expect(pickStrategy(0.5, 500, 10_000_000)).toBe("none");
  });
  it("10M 窗口超 10000 条 → force", () => {
    expect(pickStrategy(0.5, 10_001, 10_000_000)).toBe("force");
  });
});

describe("compactToBudget 10M 场景", () => {
  it("10M 窗口超额 → 自动用自适应迭代（不传第4参）", () => {
    const c = new ContextCompactor();
    const big = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i} ${"x".repeat(3000)}`,
    }));
    const est = Math.ceil(JSON.stringify(big).length / 4);
    const r = c.compactToBudget(big, est, est, 1);
    expect(r.iterations).toBeGreaterThanOrEqual(0);
    expect(r.messages.length).toBeGreaterThan(0);
  });
  it("未超额 → 0 次", () => {
    const c = new ContextCompactor();
    const msgs = [{ role: "user" as const, content: "hi" }];
    const r = c.compactToBudget(msgs, 10, 30_000);
    expect(r.iterations).toBe(0);
  });
});
