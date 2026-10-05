/**
 * E87 failover 中途断流状态回滚（issue #97）
 *
 * - primary 已产出文本后 infra 故障 → 切 fallback 前 fullText/toolBuffers/events 回滚
 * - 最终 assistant 消息只含 fallback 全量文本（无重复、无 primary 残留）
 * - primary 残留的半个 tool_use_start 不产生无法配对的 tool_result
 * - primary 未产出即故障 → 行为不变（e4 已覆盖，此处回归 executeTurn 集成）
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

/** primary：输出半截文本 + 一个未完成 tool_use 后抛 infra 错误 */
function halfClient() {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "半截文本" } };
            yield { type: "content_block_stop" };
            yield { type: "content_block_start", content_block: { type: "tool_use", id: "tu_half", name: "Glob" } };
            yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"pat' } };
            throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:4100");
          })(),
      },
    },
  };
}

/** fallback：完整干净的一轮 */
function cleanClient(text = "完整输出。") {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
}

function loopState() {
  return { messages: [] as any[], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
}

async function makeEngine() {
  const { QueryEngine } = await import("../src/engine/QueryEngine");
  const cwd = mkdtempSync(join(tmpdir(), "tupig-e87-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
  });
  return engine;
}

const textOf = (m: any): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((b: any) => b?.text ?? "").join("")
      : "";

describe("中途断流 failover 回滚已累计状态", () => {
  it("assistant 消息只含 fallback 文本，不重复、无残留 tool_use", async () => {
    const engine = await makeEngine();
    engine.client = halfClient();
    engine.fallbackClient = cleanClient();
    engine.fallbackLabel = "anthropic";

    const ls = loopState();
    const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

    expect(res.stopReason).toBe("end_turn");
    expect(ls.messages).toHaveLength(1);
    const assistant = ls.messages[0];
    expect(textOf(assistant)).toBe("完整输出。");
    // 无 primary 残留：不重复、无 tu_half 残留块
    if (Array.isArray(assistant.content)) {
      const toolUses = assistant.content.filter((b: any) => b.type === "tool_use");
      expect(toolUses).toHaveLength(0);
    }
    // 事件序列不含无法配对的 tool_result
    expect(res.toolResults).toHaveLength(0);
    expect(res.events.filter((e: any) => e.type === "tool_result")).toHaveLength(0);
  }, 15_000);

  it("primary 未产出即 infra 故障 → 直接 fallback（行为回归）", async () => {
    const engine = await makeEngine();
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              throw new Error("ECONNREFUSED");
            })(),
        },
      },
    };
    engine.fallbackClient = cleanClient("兜底输出。");
    engine.fallbackLabel = "anthropic";

    const ls = loopState();
    const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

    expect(res.stopReason).toBe("end_turn");
    expect(textOf(ls.messages[0])).toBe("兜底输出。");
  }, 15_000);
});
