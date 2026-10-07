/**
 * E1 provider 抽象测试
 * 覆盖：配置优先级 / baseURL 归一 / OpenAI SSE 解析（含 tool_calls 分片）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveProvider, chatUrl, parseOpenAISSE, type ProviderKind } from "../../src/services/api";

type Env = Record<string, string | undefined>;
function withEnv(env: Env, fn: () => void) {
  const saved: Env = {};
  for (const k of ["TUPIG_MOCK", "TUPIG_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.entries(env).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; });
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  }
}

describe("resolveProvider 配置优先级", () => {
  it("TUPIG_MOCK=1 → mock（最高优先级）", () => {
    withEnv({ TUPIG_MOCK: "1", OPENAI_BASE_URL: "http://x", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" },
      () => expect(resolveProvider()).toBe("mock"));
  });
  it("显式 TUPIG_PROVIDER=openai 覆盖 anthropic env", () => {
    withEnv({ TUPIG_PROVIDER: "openai", OPENAI_BASE_URL: "http://x", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" },
      () => expect(resolveProvider()).toBe("openai"));
  });
  it("OPENAI_BASE_URL+KEY → openai", () => {
    withEnv({ OPENAI_BASE_URL: "http://x", OPENAI_API_KEY: "k" },
      () => expect(resolveProvider()).toBe("openai"));
  });
  it("仅 ANTHROPIC_API_KEY → anthropic", () => {
    withEnv({ ANTHROPIC_API_KEY: "a" }, () => expect(resolveProvider()).toBe("anthropic"));
  });
  it("全无配置 → 抛中文错误", () => {
    withEnv({}, () => expect(() => resolveProvider()).toThrow(/设置|配置/));
  });
  it("显式 provider 非法值 → 抛错", () => {
    withEnv({ TUPIG_PROVIDER: "foo" }, () => expect(() => resolveProvider()).toThrow());
  });
});

describe("chatUrl baseURL 归一", () => {
  it("裸 host 补 /v1", () => {
    expect(chatUrl("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100/v1/chat/completions");
  });
  it("已含 /v1 不重复", () => {
    expect(chatUrl("http://127.0.0.1:4100/v1")).toBe("http://127.0.0.1:4100/v1/chat/completions");
  });
  it("尾斜杠归一", () => {
    expect(chatUrl("http://h/v1/")).toBe("http://h/v1/chat/completions");
    expect(chatUrl("http://h/")).toBe("http://h/v1/chat/completions");
  });
  it("自定义子路径（网关前缀）保留", () => {
    expect(chatUrl("http://h/api/openai")).toBe("http://h/api/openai/v1/chat/completions");
  });
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l + "\n")); c.close(); },
  });
}

async function collect(stream: AsyncGenerator<any>) {
  const out: any[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("parseOpenAISSE 流解析", () => {
  it("纯文本增量 + finish_reason 映射", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"世界"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const text = evs.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    expect(text).toBe("你好世界");
    const md = evs.find((e) => e.type === "message_delta");
    expect(md.stopReason).toBe("end_turn");
    expect(evs[0].type).toBe("message_start");
    expect(evs.at(-1).type).toBe("message_stop");
  });

  it("tool_calls 分片累积 + 首包无 id 时生成稳定 id + finish=tool_use", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_1","function":{"name":"Edit","arguments":"{\\"pa"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const start = evs.find((e) => e.type === "tool_use_start");
    expect(start.name).toBe("Edit");
    expect(start.id).toBe("toolu_1");
    const deltas = evs.filter((e) => e.type === "tool_use_delta");
    expect(deltas.map((d) => d.inputJsonDelta).join("")).toBe('{"path":"a.ts"}');
    expect(deltas.every((d) => d.id === start.id)).toBe(true);
    expect(evs.find((e) => e.type === "message_delta").stopReason).toBe("tool_use");
  });

  it("首包无 id → 自生成 id 并全程保持一致", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"Read","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const start = evs.find((e) => e.type === "tool_use_start");
    expect(start.id).toMatch(/^toolu_/);
    expect(evs.filter((e) => e.type === "tool_use_delta").every((d) => d.id === start.id)).toBe(true);
  });

  it("多个并行 tool_calls 按 index 分流", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"Read","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"Glob","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    const starts = evs.filter((e) => e.type === "tool_use_start");
    expect(starts.map((s) => s.id).sort()).toEqual(["a", "b"]);
    const stops = evs.filter((e) => e.type === "tool_use_stop");
    expect(stops).toHaveLength(2);
  });

  it("坏行跳过不抛错", async () => {
    const body = sseBody([
      "data: {broken json",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
    ]);
    const evs = await collect(parseOpenAISSE(body, "m"));
    expect(evs.find((e) => e.type === "text_delta")?.text).toBe("ok");
  });
});
