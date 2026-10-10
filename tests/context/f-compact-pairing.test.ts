/**
 * F 压缩配对消毒（fix #119）：snip/microcompact/contextCollapse 切片不得留下悬挂 tool_use/tool_result。
 */
import { describe, expect, it } from "vitest";
import { ContextCompactor, sanitizeToolPairing } from "../../src/context/compact/index";
import type Anthropic from "@anthropic-ai/sdk";

const use = (id: string): Record<string, unknown> => ({
  type: "tool_use", id, name: "Bash", input: { command: "ls" },
});
const res = (id: string): Record<string, unknown> => ({
  type: "tool_result", tool_use_id: id, content: "ok",
});
const asst = (...blocks: unknown[]): Anthropic.MessageParam =>
  ({ role: "assistant", content: blocks }) as Anthropic.MessageParam;
const usr = (...blocks: unknown[]): Anthropic.MessageParam =>
  ({ role: "user", content: blocks }) as Anthropic.MessageParam;
const text = (t: string): Record<string, unknown> => ({ type: "text", text: t });

const dangling = (messages: Anthropic.MessageParam[]): string[] => {
  const pending = new Set<string>();
  const bad: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === "tool_use") pending.add(b.id);
      if (b?.type === "tool_result") {
        if (!pending.has(b.tool_use_id)) bad.push(b.tool_use_id);
        else pending.delete(b.tool_use_id);
      }
    }
  }
  for (const id of pending) bad.push(id);
  return bad;
};

describe("sanitizeToolPairing", () => {
  it("完全配对 → 原样返回（同一引用）", () => {
    const msgs = [usr(text("hi")), asst(use("u1")), usr(res("u1"), text("继续"))];
    expect(sanitizeToolPairing(msgs)).toBe(msgs);
  });

  it("孤立 tool_result（id 从未出现）→ 剔除", () => {
    const msgs = [usr(res("ghost"))];
    const out = sanitizeToolPairing(msgs);
    expect(dangling(out)).toEqual([]);
    expect((out[0].content as any[]).some((b) => b.type === "tool_result")).toBe(false);
  });

  it("assistant tool_use 无后续消费 → 占位替换，后续孤儿 result 一并剔除", () => {
    const msgs = [asst(use("u1")), usr(text("没带结果")), asst(text("回复")), usr(res("u1"))];
    const out = sanitizeToolPairing(msgs);
    expect(dangling(out)).toEqual([]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
    expect(blocks.some((b) => b.type === "text" && String(b.text).includes("已省略"))).toBe(true);
  });

  it("部分消费：多 tool_use 只回了一个 → 未回的剔除、已回的保留", () => {
    const msgs = [asst(use("u1"), use("u2")), usr(res("u1"))];
    const out = sanitizeToolPairing(msgs);
    expect(dangling(out)).toEqual([]);
    const ids = (out[0].content as any[]).filter((b) => b.type === "tool_use").map((b) => b.id);
    expect(ids).toEqual(["u1"]);
  });

  it("user 整条只剩被剔内容 → 保底占位文本非空", () => {
    const msgs = [usr(res("ghost"))];
    const out = sanitizeToolPairing(msgs);
    const blocks = out[0].content as any[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].type).toBe("text");
  });
});

describe("流水线出口消毒（ContextCompactor）", () => {
  it("snip 摧毁中段 tool_result 后，sanitize 恢复可发送形态", () => {
    const pipe = new ContextCompactor();
    const msgs: Anthropic.MessageParam[] = [
      usr(text("任务")),
      asst(use("u1")), usr(res("u1")),
      asst(use("u2")), usr(res("u2")),
      asst(text("ok")),
    ];
    const snipped = pipe.snip(msgs);
    expect(snipped.length).toBe(msgs.length);
    const out = sanitizeToolPairing(snipped);
    expect(dangling(out)).toEqual([]);
  });

  it("compactToBudget 超预算强制压缩后无悬挂", () => {
    const pipe = new ContextCompactor();
    const msgs: Anthropic.MessageParam[] = [usr(text("首条"))];
    for (let i = 0; i < 20; i++) {
      msgs.push(asst(use(`u${i}`)), usr(res(`u${i}`), text(`步 ${i}`)));
    }
    const { messages } = pipe.compactToBudget(msgs, 100_000, 1_000);
    expect(dangling(messages)).toEqual([]);
  });
});
