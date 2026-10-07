/**
 * E86 max_tokens 截断升级重试（issue #96）
 *
 * - Anthropic 链路 stop_reason=max_tokens → 升级重试（首档 → 16384）
 * - 重试后 end_turn → 成功
 * - 升级耗尽 → error result，不报成功
 * - 升级基线跟随当前上限：config.maxTokens=32768 时从 65536 起（不降级）
 * - OpenAI finish_reason=length → stopReason=max_tokens（不吞成 end_turn）
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseOpenAISSE } from "../../src/services/api";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

/** stop_reason 序列按调用次序返回（每次流一个 stop_reason） */
function seqClient(stopReasons: string[], captured: number[] = []) {
  let call = 0;
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: (params: any) => {
          captured.push(params.max_tokens);
          const stop = stopReasons[Math.min(call, stopReasons.length - 1)];
          call++;
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "半截输出" } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })();
        },
      },
    },
  };
}

async function makeEngine(maxTokens = 8192) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const cwd = mkdtempSync(join(tmpdir(), "tupig-e86-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens, maxTurns: 3, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  return engine;
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("Anthropic stop_reason=max_tokens → 升级重试", () => {
  it("max_tokens 后重试升到 16384，第二次 end_turn → 成功", async () => {
    const engine = await makeEngine(8192);
    const caps: number[] = [];
    engine.client = seqClient(["max_tokens", "end_turn"], caps);

    const out = await collect(engine.submitMessage("写一段长输出"));

    expect(caps).toHaveLength(2);
    expect(caps[0]).toBe(8192);
    expect(caps[1]).toBe(16384);
    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("success");
  }, 15_000);

  it("升级耗尽 → error result，不报成功", async () => {
    const engine = await makeEngine(8192);
    const caps: number[] = [];
    engine.client = seqClient(["max_tokens"], caps); // 每次都截断

    const out = await collect(engine.submitMessage("写一段长输出"));

    expect(caps).toHaveLength(4); // 4 档阶梯用尽
    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");
    expect(results[0].result).toContain("max_tokens");
  }, 15_000);

  it("基线跟随 config.maxTokens：32768 起步失败 → 升 65536（不降级到 16384）", async () => {
    const engine = await makeEngine(32768);
    const caps: number[] = [];
    engine.client = seqClient(["max_tokens", "end_turn"], caps);

    const out = await collect(engine.submitMessage("写一段长输出"));

    expect(caps[1]).toBe(65536);
    expect(out.filter((m) => m.type === "result")[0].subtype).toBe("success");
  }, 15_000);
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l + "\n")); c.close(); },
  });
}

describe("OpenAI finish_reason=length 保留截断语义", () => {
  it("length → stopReason=max_tokens", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"半截"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      "data: [DONE]",
    ]);
    const out: any[] = [];
    for await (const ev of parseOpenAISSE(body, "m")) out.push(ev);
    const md = out.find((e) => e.type === "message_delta");
    expect(md.stopReason).toBe("max_tokens");
  });

  it("stop 仍映射 end_turn（回归）", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const out: any[] = [];
    for await (const ev of parseOpenAISSE(body, "m")) out.push(ev);
    expect(out.find((e) => e.type === "message_delta").stopReason).toBe("end_turn");
  });
});
