/**
 * E16 Provider 错误标准分类：kind/status/retryable/failoverEligible。
 * 来源思路：LiteLLM 错误分类（MIT）；对应 issue #5。
 */
import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../../src/services/errors";
import { isInfraError } from "../../src/services/failover";

describe("classifyProviderError", () => {
  it("429 / rate limit → rate_limit，可 failover", () => {
    const r = classifyProviderError(new Error("OpenAI API 返回错误 429：rate limit exceeded"));
    expect(r.kind).toBe("rate_limit");
    expect(r.status).toBe(429);
    expect(r.failoverEligible).toBe(true);
    expect(r.retryable).toBe(true);
  });

  it("529 overloaded → overloaded，可 failover", () => {
    const r = classifyProviderError(new Error("overloaded_error: 529 Overloaded"));
    expect(r.kind).toBe("overloaded");
    expect(r.status).toBe(529);
    expect(r.failoverEligible).toBe(true);
  });

  it("401/403 → auth，不 failover（保持 e4 现状语义）", () => {
    for (const msg of ["返回错误 401：unauthorized", "invalid api key", "forbidden 403"]) {
      const r = classifyProviderError(new Error(msg));
      expect(r.kind).toBe("auth");
      expect(r.failoverEligible).toBe(false);
    }
  });

  it("context 超长 400 → context_too_long，不 failover", () => {
    const r = classifyProviderError(new Error("context length exceeded maximum of 200000 tokens"));
    expect(r.kind).toBe("context_too_long");
    expect(r.failoverEligible).toBe(false);
    expect(r.retryable).toBe(true); // issue #24：本端压缩后重试
  });

  it("5xx 其他 → server，可 failover", () => {
    expect(classifyProviderError(new Error("status 503")).kind).toBe("server");
    const r = classifyProviderError(new Error("返回错误 502：bad gateway"));
    expect(r.kind).toBe("server");
    expect(r.failoverEligible).toBe(true);
    expect(r.status).toBe(502);
  });

  it("网络错误码 → network，可 failover", () => {
    for (const msg of ["fetch failed: ECONNREFUSED 127.0.0.1:4100", "connect ETIMEDOUT", "socket hang up", "server crashed: out of memory"]) {
      const r = classifyProviderError(new Error(msg));
      expect(r.kind).toBe("network");
      expect(r.failoverEligible).toBe(true);
    }
  });

  it("裸 500：普通消息含数字 → unknown，不 failover", () => {
    const r = classifyProviderError(new Error("这个套餐价格是 500 元"));
    expect(r.kind).toBe("unknown");
    expect(r.failoverEligible).toBe(false);
  });

  it("SDK 风格对象（status 属性，message 无 status 词）", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const r = classifyProviderError(err);
    expect(r.kind).toBe("rate_limit");
    expect(r.failoverEligible).toBe(true);
  });

  it("4xx 其他 → invalid_request，不 failover", () => {
    const r = classifyProviderError(new Error("invalid request 400: bad parameter"));
    expect(r.kind).toBe("invalid_request");
    expect(r.failoverEligible).toBe(false);
  });
});

describe("isInfraError 兼容层（failover 语义）", () => {
  it("529/429 → true（现状漏判修复）", () => {
    expect(isInfraError(new Error("529 Overloaded"))).toBe(true);
    expect(isInfraError(new Error("返回错误 429：rate limit"))).toBe(true);
  });

  it("401 → false（e4 语义保持）", () => {
    expect(isInfraError(new Error("OpenAI API 返回错误 401：unauthorized"))).toBe(false);
  });

  it("ECONNREFUSED / 503 / OOM → true（e4 现状保持）", () => {
    expect(isInfraError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:4100"))).toBe(true);
    expect(isInfraError(new Error("status 503"))).toBe(true);
    expect(isInfraError(new Error("MLX server crashed: out of memory"))).toBe(true);
  });

  it("max_tokens exceed / 裸数字 → false", () => {
    expect(isInfraError(new Error("max_tokens exceed"))).toBe(false);
    expect(isInfraError(new Error("价格 500 元"))).toBe(false);
  });
});
