/**
 * E27 上下文溢出自动恢复（issue #24）
 * 分类可重试 / 溢出重试限 2 次后报错 / 恢复走压缩流水线 / 与 max_tokens 升级互不干扰
 */
import { describe, it, expect } from "vitest";
import { classifyProviderError } from "../../src/services/errors";
import {
  isContextOverflow,
  MAX_OVERFLOW_RETRIES,
  OverflowRecovery,
} from "../../src/engine/overflowRecovery";
import { ContextCompactor, estimateTokens } from "../../src/context/compact/index";
import type { ApiClient } from "../../src/services/api";

const mockClient: ApiClient = { type: "mock" };

function overflowErr() {
  return new Error("prompt is too long: 250000 tokens > 200000 maximum");
}

function makeMessages(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第 ${i} 轮内容 ${"详细文本 ".repeat(30)}`,
  }));
}

describe("分类：context_too_long 可重试", () => {
  it("retryable=true 且 failoverEligible=false（本端恢复，不切 provider）", () => {
    const c = classifyProviderError(overflowErr());
    expect(c.kind).toBe("context_too_long");
    expect(c.retryable).toBe(true);
    expect(c.failoverEligible).toBe(false);
  });

  it("413 状态码同分类", () => {
    const e = new Error("Request Entity Too Large") as Error & { status: number };
    e.status = 413;
    expect(classifyProviderError(e).kind).toBe("context_too_long");
  });

  it("isContextOverflow 只认上下文溢出", () => {
    expect(isContextOverflow(overflowErr())).toBe(true);
    expect(isContextOverflow(new Error("rate limit 429"))).toBe(false);
    expect(isContextOverflow(new Error("max_tokens exceeded"))).toBe(false);
  });
});

describe("OverflowRecovery 重试闸门", () => {
  it("前 2 次溢出允许重试，第 3 次拒绝", () => {
    const r = new OverflowRecovery();
    expect(r.shouldRetry(overflowErr())).toBe(true);
    expect(r.shouldRetry(overflowErr())).toBe(true);
    expect(r.shouldRetry(overflowErr())).toBe(false);
    expect(MAX_OVERFLOW_RETRIES).toBe(2);
  });

  it("非溢出错误立即拒绝，且不消耗额度", () => {
    const r = new OverflowRecovery();
    expect(r.shouldRetry(new Error("401 unauthorized"))).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.shouldRetry(overflowErr())).toBe(true);
  });

  it("reset 后额度恢复", () => {
    const r = new OverflowRecovery();
    r.shouldRetry(overflowErr());
    r.reset();
    expect(r.attempts).toBe(0);
  });
});

describe("恢复走压缩流水线", () => {
  it("recover 调用 autoCompact 后消息变短", async () => {
    const r = new OverflowRecovery();
    const compactor = new ContextCompactor();
    const msgs = makeMessages(14);
    const before = estimateTokens(msgs);
    const out = await r.recover(compactor, mockClient, "mock-model", msgs);
    expect(estimateTokens(out)).toBeLessThan(before);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0].content).toContain("摘要");
  });

  it("压缩后仍保留最近消息（近 6 条线索）", async () => {
    const r = new OverflowRecovery();
    const msgs = makeMessages(14);
    const out = await r.recover(new ContextCompactor(), mockClient, "m", msgs);
    const last = JSON.stringify(out[out.length - 1]);
    expect(last).toContain("第 13 轮");
  });

  it("消息过少时 recover 原样返回（不崩）", async () => {
    const r = new OverflowRecovery();
    const msgs = makeMessages(3);
    const out = await r.recover(new ContextCompactor(), mockClient, "m", msgs);
    expect(out).toHaveLength(3);
  });
});
