/**
 * E47 token 估算/usage 口径校准（#44）
 *
 * - estimateTokens 计入 system prompt + tool schema（chars/4 同口径）
 * - UsageTracker：首帧记入、末帧非零覆盖，input/cache_read/cache_creation 全量入账
 * - OpenAI 直连：stream_options.include_usage 注入 + 末帧 usage-only chunk 解析
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseOpenAISSE, streamMessage, UsageTracker } from "../../src/services/api";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + "\n"));
      c.close();
    },
  });
}

async function collect(stream: AsyncGenerator<any>) {
  const out: any[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("estimateTokens 计入 system + tool schema", () => {
  it("system/tools 段按 chars/4 累加进估算", async () => {
    const { QueryEngine } = await import("../../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-a2-"));
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    const msgs = [{ role: "user", content: "hi" }];
    const base = engine.estimateTokens(msgs);
    const withSys = engine.estimateTokens(msgs, "s".repeat(400));
    expect(withSys - base).toBe(100);
    const tools = [{ name: "Glob", description: "d".repeat(800), input_schema: { type: "object" } }];
    const withTools = engine.estimateTokens(msgs, "", tools);
    expect(withTools).toBeGreaterThan(base);
    expect(engine.estimateTokens(msgs, "s".repeat(400), tools)).toBe(withSys + (withTools - base));
  });
});

describe("UsageTracker 末帧 usage 优先", () => {
  it("首帧记入 input + cache 字段全量，末帧非零覆盖", () => {
    const u = new UsageTracker();
    u.record({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } as any);
    expect(u.inputTokens).toBe(170);
    expect(u.outputTokens).toBe(1);
    u.record({ input_tokens: 0, output_tokens: 90 } as any);
    expect(u.inputTokens).toBe(170);
    expect(u.outputTokens).toBe(90);
    u.record({ input_tokens: 120, output_tokens: 95 } as any);
    expect(u.inputTokens).toBe(120);
    expect(u.outputTokens).toBe(95);
  });

  it("空/零 usage 帧不冲掉已有值", () => {
    const u = new UsageTracker();
    u.record({ input_tokens: 42, output_tokens: 7 } as any);
    u.record(undefined);
    u.record({ input_tokens: 0, output_tokens: 0 } as any);
    expect(u.inputTokens).toBe(42);
    expect(u.outputTokens).toBe(7);
  });
});

describe("parseOpenAISSE 末帧 usage-only chunk", () => {
  it("finish 后的 usage chunk（无 choices）入账并带进 message_delta", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":42}}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const md = evs.find((e) => e.type === "message_delta");
    expect(md).toBeTruthy();
    expect(md.stopReason).toBe("end_turn");
    expect(md.usage.input_tokens).toBe(300);
    expect(md.usage.output_tokens).toBe(42);
    expect(evs.at(-1).type).toBe("message_stop");
    expect(evs.indexOf(md)).toBeLessThan(evs.length - 1);
  });

  it("usage 并入 finish 同一 chunk 时也能入账", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const md = evs.find((e) => e.type === "message_delta");
    expect(md.stopReason).toBe("tool_use");
    expect(md.usage.input_tokens).toBe(10);
    expect(md.usage.output_tokens).toBe(3);
  });

  it("无 finish_reason 不发 message_delta（保持旧行为）", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    expect(evs.find((e) => e.type === "message_delta")).toBeUndefined();
    expect(evs.at(-1).type).toBe("message_stop");
  });
});

describe("OpenAI 直连请求注入 include_usage", () => {
  it("请求体带 stream_options.include_usage 且末帧 usage 可解析", async () => {
    const orig = globalThis.fetch;
    let captured: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      const body = sseBody([
        'data: {"choices":[{"delta":{"content":"x"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":77,"completion_tokens":9}}',
        "data: [DONE]",
      ]);
      return { ok: true, status: 200, body } as any;
    }) as any;
    const prevBase = process.env.OPENAI_BASE_URL;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = "http://fake.local/v1";
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const evs = await collect(
        streamMessage({ type: "openai" }, "m", 128, "sys", [{ role: "user", content: "x" }] as any, []),
      );
      expect(captured?.stream_options).toEqual({ include_usage: true });
      const md = evs.find((e) => e.type === "message_delta");
      expect(md.usage.input_tokens).toBe(77);
      expect(md.usage.output_tokens).toBe(9);
    } finally {
      globalThis.fetch = orig;
      if (prevBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }
  });
});
