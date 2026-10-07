/**
 * e81: anthropic 摘要链路超时与失败回退（issue #91）
 *
 * anthropic messages.create 补 AbortSignal.timeout（openai 链路已有 30s），
 * 摘要挂起即中断，失败回退 budgetReduction。
 */
import { describe, expect, it, vi } from "vitest";
import { llmSummary, ContextCompactor } from "../../src/context/compact/index";

describe("llmSummary anthropic 超时接线（issue #91）", () => {
  it("messages.create 收到 AbortSignal timeout 选项", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "S" }],
    });
    const client = {
      type: "anthropic",
      anthropic: { messages: { create } },
    } as any;

    const s = await llmSummary(client, "mock-model", [{ role: "user", content: "hi" }]);
    expect(s).toBe("S");
    expect(create).toHaveBeenCalledTimes(1);
    const requestOpts = create.mock.calls[0]?.[1];
    expect(requestOpts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("mock 链路回归：摘要正常返回", async () => {
    const s = await llmSummary({ type: "mock" } as any, "m", [
      { role: "user", content: "hi" },
    ]);
    expect(s).toContain("mock");
  });
});

describe("摘要失败回退（issue #91）", () => {
  it("anthropic create 抛错 → autoCompact 回退预算削减（keep_first）不抛", async () => {
    const client = {
      type: "anthropic",
      anthropic: {
        messages: {
          create: vi.fn().mockRejectedValue(new Error("timeout abort")),
        },
      },
    } as any;
    const c = new ContextCompactor();
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    const out = await c.autoCompact(client, "m", msgs as any);
    expect(out.length).toBeLessThan(12);
    expect(out[0]).toBe(msgs[0] as never); // 首条主任务指令保留
  });
});
