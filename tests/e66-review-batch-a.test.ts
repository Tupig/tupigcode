/**
 * E66 A 批深度审查（#43-#47）
 *
 * 审查点 1（A-1，#45）：消息缓存断点必须落在 content block 级
 *   ——Anthropic SDK 的 MessageParam 类型无顶层 cache_control；
 *     官方做法是给最后一条消息的最后一个 content block 打断点
 *     （或请求体顶层自动缓存），塞 MessageParam 顶层 = 非法/无效层级。
 *
 * 审查点 2（#47）：max_tokens 升级重试时，上一轮早期派发的 stale 结果
 *   必须从 toolResults/events 移除——第一轮 assistant 消息未入对话史，
 *   残留 tool_result 会导致下一轮 API 报「找不到对应 tool_use」。
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { withMessageCacheBreakpoint } from "../src/services/api";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("A-1 消息缓存断点层级（规范：block 级，非 MessageParam 顶层）", () => {
  const base = () => [
    { role: "user", content: "第一问" },
    { role: "assistant", content: [{ type: "text", text: "答" }] },
    { role: "user", content: "第二问" },
  ] as any[];

  it("输出的 MessageParam 顶层不携带 cache_control", () => {
    const out = withMessageCacheBreakpoint(base());
    for (const m of out) {
      expect(m).not.toHaveProperty("cache_control");
    }
  });

  it("断点落在最后一条消息的最后一个 content block；string content 转 blocks", () => {
    const out = withMessageCacheBreakpoint(base());
    const last = out[out.length - 1] as any;
    expect(typeof last.content).not.toBe("string");
    const blocks = last.content as any[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
    // 最后一条消息的其余 block 不带断点（断点唯一、省 slot）
    for (const b of blocks.slice(0, -1)) {
      expect(b.cache_control).toBeUndefined();
    }
  });

  it("历史消息的任何 block 级断点被清理（防跨轮累积超 4 个上限）", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "旧轮", cache_control: { type: "ephemeral" } },
          { type: "text", text: "旧轮2" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "答" }] },
    ] as any[];
    const out = withMessageCacheBreakpoint(msgs);
    const oldBlocks = out[0].content;
    for (const b of oldBlocks) expect(b.cache_control).toBeUndefined();
    const lastBlocks = out[out.length - 1].content;
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("原 messages 数组不被就地修改", () => {
    const msgs = base();
    const snapshot = JSON.stringify(msgs);
    withMessageCacheBreakpoint(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("空数组原样返回", () => {
    expect(withMessageCacheBreakpoint([])).toEqual([]);
  });
});

describe("审查点 2：max_tokens 重试清 stale 早期派发结果（#47）", () => {
  it("第一轮 early 结果不残留在最终 toolResults/events", async () => {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e66-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, "needle.txt"), "alpha\nbeta\n");

    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;

    let streamCalls = 0;
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () => {
            streamCalls++;
            if (streamCalls === 1) {
              // 第一轮：完整 tool_use（触发早期派发）→ 尾部抛 max_tokens 触发升级重试
              return (async function* () {
                yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
                yield { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_stale", name: "Grep" } };
                yield {
                  type: "content_block_delta",
                  delta: { type: "input_json_delta", partial_json: JSON.stringify({ pattern: "alpha", path: dir }) },
                };
                yield { type: "content_block_stop" };
                throw new Error("Request exceeds max_tokens limit for model");
              })();
            }
            // 第二轮：纯文本正常收尾（无 tool_use）
            return (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_start", content_block: { type: "text" } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } };
              yield { type: "content_block_stop" };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
              yield { type: "message_stop" };
            })();
          },
        },
      },
    };

    const loopState = {
      messages: [] as any[], turnCount: 1, compacted: false,
      maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
    };
    const res = await (engine as any).executeTurn(
      loopState,
      (engine as any).buildToolContext(),
      async () => ({ behavior: "allow" }),
    );

    expect(streamCalls).toBeGreaterThanOrEqual(2); // 确实走了升级重试
    expect(res.toolResults.some((r: any) => r.tool_use_id === "toolu_stale")).toBe(false);
    expect(
      res.events.some((e: any) => e.type === "tool_result" && e.toolUseId === "toolu_stale"),
    ).toBe(false);
    // 第二轮无 tool_use → 最终不应有任何工具结果
    expect(res.toolResults).toHaveLength(0);
  }, 20_000);
});
