/**
 * E89 兜底模型解析（issue #98 问题 1）
 *
 * - resolveFallbackModel：explicit 优先 → anthropic 默认云模型 → openai 走 OPENAI_MODEL
 * - 执行级：兜底流用云模型名，不沿用本地 config.model（14b 发往云端必 404）
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

describe("resolveFallbackModel 单元", () => {
  it("explicit（config.fallbackModel）优先", async () => {
    const { resolveFallbackModel } = await import("../src/services/failover");
    expect(resolveFallbackModel("anthropic", "my-cloud-model", {} as any)).toBe("my-cloud-model");
    expect(resolveFallbackModel("openai", "gpt-x", {} as any)).toBe("gpt-x");
  });

  it("anthropic 缺省 → TUPIG_CLOUD_MODEL || claude-sonnet-4", async () => {
    const { resolveFallbackModel } = await import("../src/services/failover");
    expect(resolveFallbackModel("anthropic", undefined, { TUPIG_CLOUD_MODEL: "my-claude" } as any)).toBe("my-claude");
    expect(resolveFallbackModel("anthropic", undefined, {} as any)).toBe("claude-sonnet-4-20250514");
  });

  it("openai 缺省 → OPENAI_MODEL，其次 TUPIG_CLOUD_MODEL", async () => {
    const { resolveFallbackModel } = await import("../src/services/failover");
    expect(resolveFallbackModel("openai", undefined, { OPENAI_MODEL: "gpt-oai" } as any)).toBe("gpt-oai");
    expect(
      resolveFallbackModel("openai", undefined, { OPENAI_MODEL: "gpt-oai", TUPIG_CLOUD_MODEL: "c" } as any),
    ).toBe("gpt-oai");
    expect(resolveFallbackModel("openai", undefined, { TUPIG_CLOUD_MODEL: "c" } as any)).toBe("c");
    expect(resolveFallbackModel("openai", undefined, {} as any)).toBe("claude-sonnet-4-20250514");
  });
});

describe("兜底流用云模型名（执行级）", () => {
  async function makeEngine() {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const cwd = mkdtempSync(join(tmpdir(), "tupig-e89-"));
    const engine: any = new QueryEngine({
      cwd, model: "local-14b", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    return engine;
  }

  function failPrimary() {
    return {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
              throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:4100");
            })(),
        },
      },
    };
  }

  /** 记录 streamMessage 收到的 model 参数的兜底 client */
  function capturingFallback(seen: string[]) {
    return {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: (params: any) => {
            seen.push(params.model);
            return (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "兜底输出。" } };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
              yield { type: "message_stop" };
            })();
          },
        },
      },
    };
  }

  it("config 未配 fallbackModel → 用默认云模型（非本地 model）", async () => {
    const engine = await makeEngine();
    engine.client = failPrimary();
    const seen: string[] = [];
    engine.fallbackClient = capturingFallback(seen);
    engine.fallbackLabel = "anthropic";
    const prev = process.env.TUPIG_CLOUD_MODEL;
    process.env.TUPIG_CLOUD_MODEL = "claude-test-cloud";
    try {
      const ls = {
        messages: [] as any[], turnCount: 1, compacted: false,
        maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
      };
      const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
      expect(res.stopReason).toBe("end_turn");
      expect(seen).toEqual(["claude-test-cloud"]);
      expect(seen).not.toContain("local-14b");
    } finally {
      if (prev === undefined) delete process.env.TUPIG_CLOUD_MODEL;
      else process.env.TUPIG_CLOUD_MODEL = prev;
    }
  }, 15_000);

  it("config.fallbackModel 显式配置优先", async () => {
    const engine = await makeEngine();
    engine.client = failPrimary();
    engine.config.fallbackModel = "explicit-cloud-model";
    const seen: string[] = [];
    engine.fallbackClient = capturingFallback(seen);
    engine.fallbackLabel = "anthropic";

    const ls = {
      messages: [] as any[], turnCount: 1, compacted: false,
      maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
    };
    const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    expect(res.stopReason).toBe("end_turn");
    expect(seen).toEqual(["explicit-cloud-model"]);
  }, 15_000);
});
