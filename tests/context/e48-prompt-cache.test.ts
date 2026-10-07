/**
 * E48 prompt cache 稳定前缀 + cache_control 断点（#45）
 *
 * - system 分层：稳定层带 cache_control 断点，易变层（lineage/状态）排在断点之后不破坏前缀
 * - anthropic 请求：tools 末项 + system 稳定层 + 末条消息末 block 三断点（fix #63 block 级），历史残留断点先清理（上限 4）
 * - OpenAI/mock：blocks 展平为字符串，不外泄 cache_control 字段
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  systemText,
  withToolsCacheBreakpoint,
  withMessageCacheBreakpoint,
  streamMessage,
} from "../../src/services/api";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("systemText 展平", () => {
  it("string 透传，blocks 按段拼接", () => {
    expect(systemText("abc")).toBe("abc");
    const blocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: "稳定层", cache_control: { type: "ephemeral" } },
      { type: "text", text: "易变层" },
    ];
    expect(systemText(blocks)).toContain("稳定层");
    expect(systemText(blocks)).toContain("易变层");
    expect(systemText(blocks)).not.toContain("cache_control");
  });
});

describe("tools/消息 cache_control 断点", () => {
  const tool = (name: string): Anthropic.Tool => ({
    name, description: "d", input_schema: { type: "object" },
  } as any);

  it("tools 仅末项带断点，空表原样", () => {
    const out = withToolsCacheBreakpoint([tool("A"), tool("B"), tool("C")]);
    expect((out[0] as any).cache_control).toBeUndefined();
    expect((out[1] as any).cache_control).toBeUndefined();
    expect((out[2] as any).cache_control).toEqual({ type: "ephemeral" });
    expect(withToolsCacheBreakpoint([])).toEqual([]);
  });

  it("末条消息带断点，历史残留断点被清理且不改原数组", () => {
    const msgs: any[] = [
      { role: "user", content: "第一轮", cache_control: { type: "ephemeral" } },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二轮" },
    ];
    const out = withMessageCacheBreakpoint(msgs);
    expect(out).not.toBe(msgs);
    expect((out[0] as any).cache_control).toBeUndefined();
    expect(msgs[0].cache_control).toEqual({ type: "ephemeral" }); // 原数组未被改
    // 断点在 block 级、MessageParam 顶层无此字段（fix #63）
    expect((out[2] as any).cache_control).toBeUndefined();
    expect(out[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(withMessageCacheBreakpoint([])).toEqual([]);
  });
});

describe("anthropic 请求三断点", () => {
  it("system 稳定层断点 + tools 末项 + 末条消息，易变层无断点", async () => {
    const captured: any = {};
    const fakeClient: any = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: (params: any) => {
            captured.params = params;
            return (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
              yield { type: "message_stop" };
            })();
          },
        },
      },
    };
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: "稳定层", cache_control: { type: "ephemeral" } },
      { type: "text", text: "易变层" },
    ];
    const tools: Anthropic.Tool[] = [
      { name: "Read", description: "r", input_schema: { type: "object" } },
      { name: "Glob", description: "g", input_schema: { type: "object" } },
    ];
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ];
    const evs: any[] = [];
    for await (const ev of streamMessage(fakeClient, "m", 100, system, msgs, tools)) evs.push(ev);

    expect(captured.params.system).toHaveLength(2);
    expect(captured.params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(captured.params.system[1].cache_control).toBeUndefined();
    expect((captured.params.tools.at(-1) as any).cache_control).toEqual({ type: "ephemeral" });
    expect((captured.params.tools[0] as any).cache_control).toBeUndefined();
    const last = captured.params.messages.at(-1);
    expect(last.cache_control).toBeUndefined();
    const lastBlocks: any[] = last.content;
    expect(lastBlocks.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(captured.params.messages[0].cache_control).toBeUndefined();
    expect(evs.at(-1).type).toBe("message_stop");
  });
});

describe("QueryEngine system 分层（稳定/易变）", () => {
  it("稳定层不含状态与变更史，易变层含；拼接与旧口径一致", async () => {
    const { QueryEngine } = await import("../../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-a3-"));
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    engine.lineageText = "abc 做了变更";
    const layers = engine.buildSystemLayers([]);
    expect(layers.stable).not.toContain("近期变更");
    expect(layers.stable).not.toContain("当前状态");
    expect(layers.volatile).toContain("近期变更");
    expect(engine.buildSystemPrompt([])).toBe(
      layers.volatile ? `${layers.stable}\n\n${layers.volatile}` : layers.stable,
    );
    expect(engine.buildSystemPrompt([])).toContain("## 近期变更");
  });
});

describe("OpenAI 路径 blocks 展平", () => {
  it("toOpenAIMessages 接收展平后的 system 字符串", async () => {
    const { toOpenAIMessages } = await import("../../src/services/api");
    const blocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: "稳定层", cache_control: { type: "ephemeral" } },
      { type: "text", text: "易变层" },
    ];
    const oai = toOpenAIMessages([{ role: "user", content: "x" }], systemText(blocks));
    expect(oai[0].role).toBe("system");
    expect(oai[0].content).toContain("稳定层");
    expect(oai[0].content).toContain("易变层");
    expect(JSON.stringify(oai)).not.toContain("cache_control");
  });
});
