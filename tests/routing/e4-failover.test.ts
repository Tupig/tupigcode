/**
 * E4 基础设施故障回退：本地 OOM/断连 → 云端兜底
 */
import { describe, expect, it } from "vitest";
import { isInfraError, resolveFallback, streamWithFailover } from "../../src/services/failover";
import type { StreamEvent } from "../../src/services/api";

describe("isInfraError 故障分类", () => {
  it("连接拒绝 → infra", () => {
    expect(isInfraError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:4100"))).toBe(true);
    expect(isInfraError(new Error("connect ECONNREFUSED"))).toBe(true);
  });
  it("5xx/502/503 → infra", () => {
    expect(isInfraError(new Error("OpenAI API 返回错误 502：bad gateway"))).toBe(true);
    expect(isInfraError(new Error("status 503"))).toBe(true);
  });
  it("OOM/内存错误 → infra", () => {
    expect(isInfraError(new Error("MLX server crashed: out of memory"))).toBe(true);
  });
  it("业务错误不回退", () => {
    expect(isInfraError(new Error("OpenAI API 返回错误 401：unauthorized"))).toBe(false);
    expect(isInfraError(new Error("max_tokens exceed"))).toBe(false);
    expect(isInfraError(new Error("invalid request 400"))).toBe(false);
  });
});

describe("resolveFallback 云端兜底配置", () => {
  const local = { OPENAI_BASE_URL: "http://127.0.0.1:4100/v1", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" };
  it("本地 openai + 有 anthropic 凭据 → anthropic 兜底", () => {
    expect(resolveFallback(local as NodeJS.ProcessEnv)).toBe("anthropic");
  });
  it("只有本地无云端 → null", () => {
    expect(resolveFallback({ OPENAI_BASE_URL: "http://l", OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("显式禁用 TUPIG_FAILOVER=off → null", () => {
    expect(resolveFallback({ ...local, TUPIG_FAILOVER: "off" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("anthropic 当前（显式） + 有 openai 配置 → openai 兜底", () => {
    expect(resolveFallback({ TUPIG_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", OPENAI_BASE_URL: "http://x", OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe("openai");
  });
});

async function* okStream(): AsyncGenerator<StreamEvent> {
  yield { type: "message_start", message: {} as any };
  yield { type: "text_delta", text: "ok" };
  yield { type: "message_delta", stopReason: "end_turn", usage: {} as any };
  yield { type: "message_stop" };
}
async function* failStream(err: Error): AsyncGenerator<StreamEvent> {
  yield { type: "message_start", message: {} as any };
  throw err;
}

describe("streamWithFailover", () => {
  it("主源 infra 故障 → 切换兜底并产出", async () => {
    const out: string[] = [];
    const gen = streamWithFailover(
      () => failStream(new Error("ECONNREFUSED")),
      () => okStream(),
      "兜底",
    );
    for await (const ev of gen) if (ev.type === "text_delta") out.push(ev.text);
    expect(out.join("")).toBe("ok");
  });
  it("业务错误不回退，直接抛", async () => {
    const gen = streamWithFailover(
      () => failStream(new Error("401 unauthorized")),
      () => okStream(),
      "兜底",
    );
    await expect(async () => { for await (const _ of gen) {} }).rejects.toThrow(/401/);
  });
  it("主源正常 → 不触发兜底", async () => {
    let fallbackCalled = false;
    const gen = streamWithFailover(
      () => okStream(),
      () => { fallbackCalled = true; return okStream(); },
      "兜底",
    );
    for await (const _ of gen) {}
    expect(fallbackCalled).toBe(false);
  });
  it("主源 infra 故障但无兜底 → 原错误抛出", async () => {
    const gen = streamWithFailover(() => failStream(new Error("ECONNREFUSED")), null, null);
    await expect(async () => { for await (const _ of gen) {} }).rejects.toThrow(/ECONNREFUSED/);
  });
});
