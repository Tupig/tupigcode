/**
 * N7 Todo 工具（A16：Claude Code TodoWrite）
 */
import { describe, expect, it } from "vitest";
import { TodoWriteInput, renderTodoState, applyTodoWrite, type TodoState } from "../../src/tools/todo";

describe("TodoWriteInput 校验", () => {
  it("合法 items 通过", () => {
    const r = TodoWriteInput.safeParse({
      items: [{ content: "做A", status: "pending", priority: "high" }],
    });
    expect(r.success).toBe(true);
  });
  it("非法 status 拒绝", () => {
    const r = TodoWriteInput.safeParse({ items: [{ content: "x", status: "nope", priority: "low" }] });
    expect(r.success).toBe(false);
  });
  it("空 content 拒绝", () => {
    const r = TodoWriteInput.safeParse({ items: [{ content: "", status: "pending", priority: "low" }] });
    expect(r.success).toBe(false);
  });
});

describe("applyTodoWrite 状态语义", () => {
  it("全量替换", () => {
    const s1 = applyTodoWrite(null, [
      { content: "A", status: "in_progress", priority: "high" },
      { content: "B", status: "pending", priority: "medium" },
    ]);
    expect(s1.items.length).toBe(2);
    expect(s1.updatedAt).toBeTruthy();
    const s2 = applyTodoWrite(s1, [{ content: "C", status: "completed", priority: "low" }]);
    expect(s2.items.length).toBe(1);
    expect(s2.items[0].content).toBe("C");
  });
});

describe("renderTodoState 注入文本", () => {
  it("状态符号+进度", () => {
    const s = applyTodoWrite(null, [
      { content: "完成", status: "completed", priority: "high" },
      { content: "进行", status: "in_progress", priority: "high" },
      { content: "待办", status: "pending", priority: "low" },
    ]);
    const text = renderTodoState(s);
    expect(text).toContain("[x] 完成");
    expect(text).toContain("[~] 进行");
    expect(text).toContain("[ ] 待办");
    expect(text).toContain("1/3");
  });
  it("null → 空串", () => {
    expect(renderTodoState(null)).toBe("");
  });
});
