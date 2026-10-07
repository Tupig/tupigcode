/**
 * E40 子代理工具超时（issue #37）
 * 挂死工具 → is_error tool_result「子代理工具超时」且任务继续 / 正常工具不受影响
 */
import { describe, it, expect, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SubAgentStreamFn } from "../../src/agents/index";

describe("子代理工具调用超时", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("挂死工具超时 → is_error tool_result + 任务继续跑满轮次", async () => {
    process.env.TUPIG_TOOL_TIMEOUT_MS = "150";
    const { SubAgentExecutor } = await import("../../src/agents/index");
    const { buildTool } = await import("../../src/engine/Tool");

    const hangTool = buildTool({
      name: "HangRead",
      inputSchema: z.object({ x: z.string().optional() }),
      description: () => "永不返回的工具",
      isReadOnly: () => true,
      async call() {
        return new Promise(() => {}); // 永不 settle
      },
    });

    const seenMessages: Anthropic.MessageParam[][] = [];
    const stream: SubAgentStreamFn = async function* (args) {
      seenMessages.push(args.messages as Anthropic.MessageParam[]);
      const id = `tu_${seenMessages.length}`;
      yield { type: "message_start", message: {} as any } as any;
      yield { type: "tool_use_start", id, name: "HangRead" } as any;
      yield { type: "tool_use_delta", id, inputJsonDelta: "{}" } as any;
      yield { type: "tool_use_stop", id } as any;
      yield { type: "message_delta", stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } as any;
      yield { type: "message_stop" } as any;
    };

    const ex = new SubAgentExecutor([hangTool], { client: { type: "mock" }, stream });
    const r = await ex.execute({ id: "t-hang", description: "卡住也继续", maxTurns: 3 }, {
      options: { debug: false, mainLoopModel: "parent", tools: [], verbose: false, isNonInteractiveSession: false },
      abortController: new AbortController(),
      readFileState: new Map(),
      getMessages: () => [],
      workDir: "/tmp",
      sessionId: "s-hang",
    } as any);

    expect(r.success).toBe(true);
    expect(r.turns).toBe(3);
    // 第 2 轮起能看到上一轮的超时 tool_result
    expect(seenMessages.length).toBeGreaterThanOrEqual(2);
    const lastUser = seenMessages[seenMessages.length - 1].filter((m) => m.role === "user").pop()!;
    const blocks = Array.isArray(lastUser.content) ? (lastUser.content as any[]) : [];
    const tr = blocks.find((b) => b.type === "tool_result");
    expect(tr).toBeTruthy();
    expect(tr.is_error).toBe(true);
    expect(tr.content).toContain("子代理工具超时");
  }, 15_000);

  it("正常工具不受影响（返回正常结果）", async () => {
    delete process.env.TUPIG_TOOL_TIMEOUT_MS;
    const { SubAgentExecutor } = await import("../../src/agents/index");
    const { buildTool } = await import("../../src/engine/Tool");

    const okTool = buildTool({
      name: "OkRead",
      inputSchema: z.object({ x: z.string().optional() }),
      description: (): any => "正常工具" as any,
      isReadOnly: () => true,
      async call() {
        return { data: "ok", resultForAssistant: "ok-result" };
      },
    } as any);

    let round = 0;
    const stream: SubAgentStreamFn = async function* (args) {
      void args;
      const id = `tu_${round}`;
      yield { type: "message_start", message: {} as any } as any;
      if (round++ < 2) {
        yield { type: "tool_use_start", id, name: "OkRead" } as any;
        yield { type: "tool_use_delta", id, inputJsonDelta: "{}" } as any;
        yield { type: "tool_use_stop", id } as any;
        yield { type: "message_delta", stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } as any;
      } else {
        yield { type: "text_delta", text: "完成" } as any;
        yield { type: "message_delta", stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as any;
      }
      yield { type: "message_stop" } as any;
    };

    const ex = new SubAgentExecutor([okTool], { client: { type: "mock" }, stream });
    const r = await ex.execute({ id: "t-ok", description: "正常跑", maxTurns: 5 }, {
      options: { debug: false, mainLoopModel: "parent", tools: [], verbose: false, isNonInteractiveSession: false },
      abortController: new AbortController(),
      readFileState: new Map(),
      getMessages: () => [],
      workDir: "/tmp",
      sessionId: "s-ok",
    } as any);

    expect(r.success).toBe(true);
    expect(r.result).toContain("完成");
    expect(r.turns).toBe(3); // 2 轮工具 + 1 轮收尾
  }, 15_000);
});
