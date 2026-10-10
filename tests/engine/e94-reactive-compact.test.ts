/**
 * E94 QueryEngine reactive compact 引擎级集成（refs #129 缺口2）：
 * - micro 档：历史估算 >60% 上下文 → compactByLadder 替换 messages，主循环继续成功
 * - force 档：>95% → autoCompact 走 mock/anthropic create 摘要，messages 以摘要重建
 * - executeTurn 内溢出恢复：首轮 stream 抛 context overflow → recover 压缩 → 重试成功
 * max_tokens 升级链路已由 e86 覆盖（不重复）。
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

function turnStream(text: string, stop = "end_turn") {
  return (async function* () {
    yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
    yield { type: "content_block_start", content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", delta: { type: "text_delta", text } };
    yield { type: "content_block_stop" };
    yield { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } };
    yield { type: "message_stop" };
  })();
}

/** 步骤序列脚本客户端：create（摘要）与 stream（对话轮）各自按队列消费 */
function scriptClient(opts: {
  streamSteps: Array<{ text: string; throwErr?: Error }>;
  createText?: string;
}) {
  let i = 0;
  let creates = 0;
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () => {
          const step = opts.streamSteps[Math.min(i, opts.streamSteps.length - 1)];
          i++;
          if (step.throwErr) throw step.throwErr;
          return turnStream(step.text);
        },
        create: async () => {
          creates++;
          return { content: [{ type: "text", text: opts.createText ?? "（脚本摘要）" }] };
        },
      },
    },
    stats: () => ({ streamCalls: i, creates }),
  };
}

function history(n: number, chars: number): Array<{ role: "user" | "assistant"; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `第 ${i} 轮 ${"历史内容".repeat(Math.ceil(chars / 4))}`,
  }));
}

async function makeEngine(initialMessages: unknown[]) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const { appStore } = await import("../../src/state/AppState");
  const cwd = mkdtempSync(join(tmpdir(), "tupig-e94-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens: 8192, maxTurns: 2, routeProvider: "mock",
    initialMessages,
  } as never);
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  return { engine, appStore };
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("reactive compact 主循环接线", () => {
  it("micro 档：历史超 60% 上下文 → 压缩替换后仍成功", async () => {
    // 25k chars/4 ≈ 6.25k…用 30×3000=90k chars ≈ 22.5k tokens，30k×0.6=18k → micro/snip 档
    const { engine, appStore } = await makeEngine(history(30, 3000) as never);
    engine.client = scriptClient({ streamSteps: [{ text: "完成" }] });
    const before = appStore.getState().compactionCount;

    const out = await collect(engine.submitMessage("继续"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("success");
    expect(appStore.getState().compactionCount).toBeGreaterThan(before);
    // 非 force 档不走 LLM 摘要：首条不是摘要消息
    expect(String(engine.currentMessages[0]?.content)).not.toContain("[之前的对话摘要]");
  }, 20_000);

  it("force 档：>95% 上下文 → autoCompact 真摘要重建 messages", async () => {
    // 30×5000=150k chars ≈ 37.5k tokens > 30k×0.95 → force
    const { engine, appStore } = await makeEngine(history(30, 5000) as never);
    const client = scriptClient({ streamSteps: [{ text: "完成" }], createText: "（e94 摘要正文）" });
    engine.client = client;
    const before = appStore.getState().compactionCount;

    const out = await collect(engine.submitMessage("继续"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("success");
    expect(appStore.getState().compactionCount).toBeGreaterThan(before);
    expect(client.stats().creates).toBeGreaterThanOrEqual(1); // 摘要走 create
    const first = String(engine.currentMessages[0]?.content);
    expect(first).toContain("[之前的对话摘要]");
    expect(first).toContain("e94 摘要正文");
  }, 20_000);
});

describe("executeTurn 溢出恢复接线", () => {
  it("首轮 stream 抛上下文溢出 → recover 压缩（>6 条历史）→ 重试成功", async () => {
    // recover 依赖 autoCompact：消息 ≤6 条时原样返回不替换 → 夹具给足历史
    const { engine, appStore } = await makeEngine(history(8, 400) as never);
    const overflow = new Error("prompt is too long: 250000 tokens > 200000 maximum");
    const client = scriptClient({
      streamSteps: [
        { text: "", throwErr: overflow }, // 首轮溢出
        { text: "恢复后完成" }, // recover 后重试
      ],
      createText: "（溢出恢复摘要）",
    });
    engine.client = client;
    const before = appStore.getState().compactionCount;

    const out = await collect(engine.submitMessage("继续"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("success");
    expect(appStore.getState().compactionCount).toBeGreaterThan(before);
  }, 20_000);

  it("溢出持续（重试仍溢出）→ 重试额度耗尽 → error result 不报成功", async () => {
    const { engine } = await makeEngine(history(8, 400) as never);
    const overflow = () => new Error("prompt is too long: 250000 tokens > 200000 maximum");
    const client = scriptClient({
      streamSteps: [
        { text: "", throwErr: overflow() },
        { text: "", throwErr: overflow() },
        { text: "", throwErr: overflow() },
      ],
      createText: "（摘要）",
    });
    engine.client = client;

    const out = await collect(engine.submitMessage("继续"));
    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");
    expect(String(results[0].result)).toMatch(/too long|溢出|超限|错误/);
  }, 20_000);
});
