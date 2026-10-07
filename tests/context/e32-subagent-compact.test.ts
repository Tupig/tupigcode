/**
 * E32 子代理自动压缩（issue #29）
 * 超预算触发压缩后继续 / 未超预算不触发 / 压缩失败不崩（回退）/ 元数据可见
 */
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SubAgentExecutor, type SubAgentStreamFn } from "../../src/agents/index";
import { buildTool, type Tool, type ToolUseContext } from "../../src/engine/Tool";

const THRESHOLD_CHARS = 30_000 * 0.6 * 4; // MAX_CONTEXT_TOKENS(30k) * LADDER_MICRO(0.6) * 4
const HUGE = "x".repeat(THRESHOLD_CHARS + 10_000);

function bigTool(): Tool {
  return buildTool({
    name: "BigRead",
    inputSchema: z.object({ x: z.string().optional() }),
    description: () => "返回巨大内容的工具",
    isReadOnly: () => true,
    async call() {
      return { data: HUGE, resultForAssistant: HUGE };
    },
  });
}

function smallTool(): Tool {
  return buildTool({
    name: "SmallRead",
    inputSchema: z.object({ x: z.string().optional() }),
    description: () => "小工具",
    isReadOnly: () => true,
    async call() {
      return { data: "ok", resultForAssistant: "ok" };
    },
  });
}

function ctx(): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "parent", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir: "/tmp",
    sessionId: "s-subcompact",
  } as unknown as ToolUseContext;
}

/** 每轮都发起一次指定工具调用的脚本流 */
function alwaysCall(toolName: string): SubAgentStreamFn {
  return async function* (args) {
    void args;
    yield { type: "message_start", message: {} as any };
    yield { type: "text_delta", text: "调用工具" };
    const id = `tu_${Date.now()}_${Math.random()}`;
    yield { type: "tool_use_start", id, name: toolName } as any;
    yield { type: "tool_use_delta", id, inputJsonDelta: "{}" } as any;
    yield { type: "tool_use_stop", id } as any;
    yield { type: "message_delta", stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } as any;
    yield { type: "message_stop" };
  };
}

describe("子代理自动压缩", () => {
  it("超预算 → 触发压缩并继续跑满 maxTurns（元数据含 compactions）", async () => {
    const ex = new SubAgentExecutor([bigTool()], {
      client: { type: "mock" },
      stream: alwaysCall("BigRead"),
    });
    const r = await ex.execute(
      { id: "t1", description: "把大内容都读一遍", maxTurns: 7 },
      ctx(),
    );
    expect(r.success).toBe(true);
    expect(r.turns).toBe(7);
    expect(r.compactions).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("未超预算 → 不触发压缩（compactions=0）", async () => {
    const ex = new SubAgentExecutor([smallTool()], {
      client: { type: "mock" },
      stream: alwaysCall("SmallRead"),
    });
    const r = await ex.execute(
      { id: "t2", description: "小任务", maxTurns: 4 },
      ctx(),
    );
    expect(r.success).toBe(true);
    expect(r.compactions).toBe(0);
  }, 20_000);

  it("压缩失败（不支持的 provider）→ 不崩，回退后继续", async () => {
    const ex = new SubAgentExecutor([bigTool()], {
      client: { type: "unsupported" } as any,
      stream: alwaysCall("BigRead"),
    });
    const r = await ex.execute(
      { id: "t3", description: "坏 provider 下也要活着", maxTurns: 7 },
      ctx(),
    );
    expect(r.success).toBe(true);
    expect(r.turns).toBe(7);
  }, 20_000);

  it("无 client（仅注入 stream）→ 压缩被安全跳过，不崩", async () => {
    const ex = new SubAgentExecutor([bigTool()], {
      stream: alwaysCall("BigRead"),
    });
    const r = await ex.execute(
      { id: "t4", description: "无 client 场景", maxTurns: 7 },
      ctx(),
    );
    expect(r.success).toBe(true);
    expect(r.turns).toBe(7);
  }, 20_000);
});
