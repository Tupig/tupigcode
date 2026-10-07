/**
 * e80: 反应式梯子压缩等值检查（issue #91）
 *
 * 9 条消息 + 高用量：microcompact 原样返回（middle<=3）时须校验 out!==before，
 * 否则误报「已压缩」+ compactionCount++ + 假熔断。
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appStore } from "../../src/state/AppState";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

type TextEvent =
  | { type: "message_start"; message: { usage: { input_tokens: number; output_tokens: number } } }
  | { type: "content_block_start"; content_block: { type: "text"; text: "" } }
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "message_stop" };

function textStream(_text: string): AsyncGenerator<TextEvent> {
  return (async function* () {
    yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
    yield { type: "content_block_start", content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } };
    yield { type: "message_stop" };
  })();
}

/** 9 条大消息：长度>8 且 middle==3 → microcompact 原样返回；tokens≈27k > 30k*0.6 */
function bigNineMessages(): { role: string; content: string }[] {
  const filler = "x".repeat(12_000);
  return Array.from({ length: 9 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${i}:${filler}`,
  }));
}

let counterBaseline = 0;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  counterBaseline = appStore.getState().compactionCount;
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  writeSpy.mockRestore();
  appStore.setState((s) => ({ ...s, compactionCount: counterBaseline }));
});

describe("反应式压缩等值检查（issue #91）", () => {
  it("micro 无效时：不计数、不打已压缩、不开熔断", async () => {
    const { QueryEngine } = await import("../../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e80-"));
    const engine: any = new QueryEngine({
      cwd: dir,
      model: "mock",
      maxTokens: 1024,
      maxTurns: 1,
      routeProvider: "mock",
      initialMessages: bigNineMessages() as any,
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () => textStream("ok"),
        },
      },
    };

    for await (const _ of engine.submitMessage("go")) {
      // 驱动单轮
    }

    const printed = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).not.toContain("已压缩");
    expect(appStore.getState().compactionCount).toBe(counterBaseline);
    expect(engine.compactor.isCircuitOpen()).toBe(false);
  });

  it("对照：microcompact 对 9 条（middle=3）确实原样返回", async () => {
    const { ContextCompactor } = await import("../../src/context/compact/index");
    const c = new ContextCompactor();
    const msgs = bigNineMessages() as any;
    expect(msgs.length).toBe(9);
    const out = c.microcompact(msgs);
    expect(out).toBe(msgs); // 等值引用 → 调用方必须自行判断
  });
});
