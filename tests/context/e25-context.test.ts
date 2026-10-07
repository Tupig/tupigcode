/**
 * E25 /compact 手动压缩 + /context 分段明细（issue #21）
 * 手动压缩走流水线（含焦点指令）/ context 分段求和≈总量 / 未压缩时基线展示
 */
import { describe, it, expect } from "vitest";
import { ContextCompactor, llmSummary, estimateTokens } from "../../src/context/compact/index";
import { contextBreakdown, estimateTextTokens } from "../../src/context/breakdown";
import type { ApiClient } from "../../src/services/api";

const mockClient: ApiClient = { type: "mock" };

function makeMessages(n: number): any[] {
  const msgs: any[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `第 ${i} 轮：请帮我看看这段代码是否正确，编号 ${i}` });
  }
  return msgs;
}

describe("/compact 手动压缩走流水线", () => {
  it("autoCompact 焦点指令透传到摘要（focus 进 mock 摘要）", async () => {
    const msgs = makeMessages(12);
    const out = await new ContextCompactor().autoCompact(mockClient, "mock-model", msgs, "只保留支付模块的决策");
    expect(out.length).toBeLessThan(msgs.length);
    const first = JSON.stringify(out[0]);
    expect(first).toContain("支付模块");
    expect(first).toContain("摘要");
  });

  it("无焦点也可压缩（默认摘要）", async () => {
    const msgs = makeMessages(10);
    const out = await new ContextCompactor().autoCompact(mockClient, "mock-model", msgs);
    expect(out.length).toBeLessThan(msgs.length);
    expect(JSON.stringify(out[0])).toContain("摘要");
  });

  it("compact 端到端：消息量与 token 双降", async () => {
    const msgs = makeMessages(14);
    const before = estimateTokens(msgs);
    const r = await new ContextCompactor().compact(mockClient, "mock-model", msgs, "聚焦重构");
    expect(r.strategy).toBeTruthy();
    expect(r.messages.length).toBeLessThanOrEqual(msgs.length);
    expect(estimateTokens(r.messages)).toBeLessThanOrEqual(before);
  });

  it("llmSummary 焦点参数生效", async () => {
    const s = await llmSummary(mockClient, "m", makeMessages(8), "数据库迁移");
    expect(s).toContain("数据库迁移");
  });

  it("消息过少 → 不压缩（保持原样）", async () => {
    const msgs = makeMessages(4);
    const out = await new ContextCompactor().autoCompact(mockClient, "m", msgs);
    expect(out).toHaveLength(4);
  });
});

describe("/context 分段明细", () => {
  const toolResultMsg = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "读取结果 ".repeat(50) },
    ],
  };

  it("分段求和 === 总量；条数统计正确", () => {
    const messages = [...makeMessages(6), toolResultMsg];
    const bd = contextBreakdown({
      systemPrompt: "系统提示词 ".repeat(40),
      messages,
      toolSchemas: [{ name: "Read", schema: { type: "object" } }, { name: "Edit", schema: { type: "object" } }],
      memories: ["记住用户偏好中文回复", "项目用 vitest"],
    });

    const sum = bd.segments.reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBe(bd.totalTokens); // 求和 === 总量

    const msgSeg = bd.segments.find((s) => s.id === "messages")!;
    const toolSeg = bd.segments.find((s) => s.id === "tool_results")!;
    expect(msgSeg.count).toBe(6);
    expect(toolSeg.count).toBe(1);

    // 消息两段之和 ≈ estimateTokens(messages)（JSON 序列化开销容差）
    const msgsTotal = msgSeg.tokens + toolSeg.tokens;
    const baseline = estimateTokens(messages);
    expect(Math.abs(msgsTotal - baseline) / baseline).toBeLessThan(0.4);
  });

  it("未压缩基线：仅消息时分段总量≈估算器", () => {
    const messages = makeMessages(8);
    const bd = contextBreakdown({ messages });
    expect(bd.segments.every((s) => s.id === "messages" || s.id === "tool_results")).toBe(true);
    const baseline = estimateTokens(messages);
    expect(Math.abs(bd.totalTokens - baseline) / baseline).toBeLessThan(0.4);
    expect(bd.totalTokens).toBeGreaterThan(0);
  });

  it("空输入 → 总量 0", () => {
    expect(contextBreakdown({ messages: [] }).totalTokens).toBe(0);
  });

  it("estimateTextTokens：≈ chars/4", () => {
    expect(estimateTextTokens("abcdefgh")).toBe(2);
    expect(estimateTextTokens("")).toBe(0);
  });
});
