/**
 * E88 Ctrl+C 优雅中断接线（issue #98）
 *
 * - 无活跃 turn → interruptActiveTurn() false（REPL 空闲走原落盘+退出）
 * - query() 注册活跃 engine：turn 中断 → 单条 error result + fireStop(output=任务已中断)
 * - executeTurn 流中途 interrupt → stopReason "aborted"，不当 API 错误、不切兜底
 * - AbortError 不是基础设施故障 → streamWithFailover 不切兜底流
 * - interrupt 与在途工具联动：callAc 收到 abort → 取消文案、不 fire PostToolUseFailure
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

async function makeEngine() {
  const { QueryEngine } = await import("../src/engine/QueryEngine");
  const cwd = mkdtempSync(join(tmpdir(), "tupig-e88-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens: 1024, maxTurns: 3, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  return engine;
}

function loopState() {
  return {
    messages: [] as any[], turnCount: 1, compacted: false,
    maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
  };
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

/** 流在首个事件后调用 onFirstEvent（模拟 turn 进行中收到 Ctrl+C） */
function slowClient(onFirstEvent: () => void) {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            onFirstEvent();
            for (const ch of "一二三四五") {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: ch } };
              await new Promise((r) => setTimeout(r, 5));
            }
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
}

describe("interruptActiveTurn 注册表", () => {
  it("无活跃 turn → false", async () => {
    const { interruptActiveTurn, activeTurnInterrupted } = await import("../src/engine/QueryEngine");
    expect(interruptActiveTurn()).toBe(false);
    expect(activeTurnInterrupted()).toBe(false);
  });

  it("query() turn 进行中 → true + interrupted；结束后回到 false", async () => {
    const { query, interruptActiveTurn, activeTurnInterrupted } = await import("../src/engine/QueryEngine");
    const iter = query({ prompt: "你好", options: { cwd: process.cwd(), model: "mock" } });
    const consume = (async () => {
      const out: any[] = [];
      for await (const msg of iter as any) out.push(msg);
      return out;
    })();
    // 轮询到活跃 turn（activeEngine 在 preloadLineage 后、submitMessage 前注册）
    let midTurn = false;
    let midInterrupted = true;
    for (let i = 0; i < 200 && !midTurn; i++) {
      const wasAborted = activeTurnInterrupted(); // 请求前状态（interruptActiveTurn 首次调用即 abort）
      if (interruptActiveTurn()) {
        midTurn = true;
        midInterrupted = wasAborted;
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const out = await consume;
    const results = out.filter((m) => m.type === "result");
    expect(midTurn).toBe(true);
    expect(midInterrupted).toBe(false); // 首次请求前未 abort
    // 中断后本轮收尾：单条 error result
    expect(results).toHaveLength(1);
    expect(results[0].result).toContain("中断");
    // turn 结束 → 注册表清空
    expect(interruptActiveTurn()).toBe(false);
  }, 30_000);
});

describe("executeTurn 流中途中断", () => {
  it("stopReason=aborted，不当 API 错误", async () => {
    const engine = await makeEngine();
    engine.client = slowClient(() => engine.interrupt());

    const res = await engine.executeTurn(
      loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" as const }),
    );

    expect(res.stopReason).toBe("aborted");
    expect(res.events.filter((e: any) => e.type === "result")).toHaveLength(0);
  }, 15_000);

  it("submitMessage 中断 → 单条 error result + fireStop(output=任务已中断)", async () => {
    const { hookSystem } = await import("../src/engine/hooks");
    const stops: any[] = [];
    hookSystem.register({ event: "Stop", handler: (c) => { stops.push(c); } });
    try {
      const engine = await makeEngine();
      engine.client = slowClient(() => engine.interrupt());

      const out = await collect(engine.submitMessage("你好"));

      const results = out.filter((m) => m.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0].subtype).toBe("error");
      expect(results[0].result).toContain("中断");
      expect(stops).toHaveLength(1);
      expect(stops[0].output).toBe("任务已中断");
    } finally {
      hookSystem.clear();
    }
  }, 15_000);
});

describe("中断不切兜底、不误报工具失败", () => {
  it("AbortError → streamWithFailover 直接抛出，fallback 不被调用", async () => {
    const { streamWithFailover } = await import("../src/services/failover");
    let fbCalled = false;
    const primary = async function* () {
      const e: any = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    };
    const fb = async function* () {
      fbCalled = true;
      yield { type: "message_stop" } as any;
    };
    await expect(collect(streamWithFailover(primary, fb, "anthropic"))).rejects.toThrow();
    expect(fbCalled).toBe(false);
  });

  it("interrupt 后在途工具 abort → 取消文案、不 fire PostToolUseFailure", async () => {
    const { hookSystem } = await import("../src/engine/hooks");
    const failures: any[] = [];
    hookSystem.register({ event: "PostToolUseFailure", handler: (c) => { failures.push(c); } });
    try {
      const engine = await makeEngine();
      // 流立即产出一个 Glob tool_use，工具执行挂住等 abort
      engine.client = {
        type: "anthropic",
        anthropic: {
          messages: {
            stream: () =>
              (async function* () {
                yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
                yield { type: "content_block_start", content_block: { type: "tool_use", id: "tu_ab", name: "Glob" } };
                yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"pattern":"**/*.ts"}' } };
                yield { type: "content_block_stop" };
                yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } };
                yield { type: "message_stop" };
              })(),
          },
        },
      };
      const tool = engine.tools.find((t: any) => t.name === "Glob");
      tool.call = (_args: any, ctx: any) =>
        new Promise((_resolve, rej) => {
          // 工具读 context.abortController：engine interrupt → callAc abort → 真取消
          ctx.abortController.signal.addEventListener("abort", () => {
            const e: any = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        });
      const ls = loopState();
      const pending = engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));
      // 等流结束、Glob 开始执行（挂住），再中断
      await new Promise((r) => setTimeout(r, 60));
      engine.interrupt();
      const res = await pending;

      expect(res.stopReason).toBe("tool_use");
      const cancelled = res.toolResults.filter((r: any) => String(r.content).includes("任务已中断"));
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].is_error).toBe(true);
      expect(failures).toHaveLength(0); // 中断引发的取消不算工具失败
    } finally {
      hookSystem.clear();
    }
  }, 15_000);
});
