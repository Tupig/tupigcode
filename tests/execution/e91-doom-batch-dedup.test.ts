/**
 * E91 doom loop 批内去重（issue #100）
 *
 * - 同批并行 3 个相同只读调用 → 只 feed 一次，不误杀
 * - 跨批同动作重复仍累计，连续 ≥3 轮触发拦截
 * - submitMessage 开始时 detector.reset + 批内集合清空 → 跨用户轮不累计
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

function loopState() {
  return {
    messages: [] as any[], turnCount: 1, compacted: false,
    maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
  };
}

/** 一轮派发 N 个相同 Glob tool_use（同批 safe 并行） */
function sameBatchClient(n: number) {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            for (let i = 0; i < n; i++) {
              yield { type: "content_block_start", content_block: { type: "tool_use", id: `tu_${i}`, name: "Glob" } };
              yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"pattern":"**/*.ts"}' } };
              yield { type: "content_block_stop" };
            }
            yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
}

async function makeEngine() {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const cwd = mkdtempSync(join(tmpdir(), "tupig-e91-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens: 1024, maxTurns: 3, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  const glob = engine.tools.find((t: any) => t.name === "Glob");
  glob.call = async () => ({ data: "a.ts" });
  return engine;
}

describe("同批相同只读调用不误杀", () => {
  it("一批 3 个相同 Glob → 全部执行，无 doom 拦截", async () => {
    const engine = await makeEngine();
    engine.client = sameBatchClient(3);

    const res = await engine.executeTurn(
      loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }),
    );

    expect(res.toolResults).toHaveLength(3);
    const doom = res.toolResults.filter((r: any) => String(r.content).includes("doom"));
    expect(doom).toHaveLength(0);
    expect(res.toolResults.every((r: any) => !r.is_error)).toBe(true);
  }, 15_000);

  it("一批 3 个相同 Glob 连跑 3 轮 → 每轮只计 1 次，第 3 轮才拦（不提前误杀）", async () => {
    const engine = await makeEngine();
    const rounds: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      engine.client = sameBatchClient(3);
      const res = await engine.executeTurn(
        loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }),
      );
      rounds.push(res.toolResults.some((r: any) => String(r.content).includes("doom")));
    }
    // 批内 3 个相同只 feed 一次 → 轮 1/2 累计 1、2 不拦；轮 3 达 3 拦（跨轮保护保留）
    expect(rounds).toEqual([false, false, true]);
  }, 30_000);
});

describe("跨轮 doom 保护保留", () => {
  it("同一动作跨 3 轮（每轮单发）→ 第 3 轮拦截", async () => {
    const engine = await makeEngine();
    engine.client = sameBatchClient(1);

    const r1 = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    const r2 = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    const r3 = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

    expect(r1.toolResults[0].is_error).toBeFalsy();
    expect(r2.toolResults[0].is_error).toBeFalsy();
    expect(r3.toolResults[0].is_error).toBe(true);
    expect(String(r3.toolResults[0].content)).toContain("doom loop");
  }, 30_000);

  it("submitMessage 开始 → detector reset，跨用户轮不累计", async () => {
    const engine = await makeEngine();
    engine.client = sameBatchClient(1);

    // 同一 submitMessage 内：executeTurn 直连跑 2 轮（detector 累计到 2）
    await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

    // 新的 submitMessage（用户新一轮）→ reset 后重新从 0 计
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
              yield { type: "message_stop" };
            })(),
        },
      },
    };
    const out: any[] = [];
    for await (const m of engine.submitMessage("你好")) out.push(m);
    expect(out.filter((m) => m.type === "result")).toHaveLength(1);

    // reset 之后再跑同动作 2 轮仍不拦（累计 2 < 3）
    engine.client = sameBatchClient(1);
    const a = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    const b = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
    expect(a.toolResults[0].is_error).toBeFalsy();
    expect(b.toolResults[0].is_error).toBeFalsy();
  }, 30_000);
});
