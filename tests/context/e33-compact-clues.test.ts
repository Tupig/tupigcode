/**
 * E33 压缩保留工具调用史（issue #30）
 * 摘要 prompt 三要素 / 线索抽取 / 二次压缩并入旧摘要 / 未压缩无变化
 */
import { describe, it, expect } from "vitest";
import {
  llmSummary,
  autoCompactKeepClues,
  extractToolClues,
  extractOldClues,
  SUMMARY_SYSTEM,
} from "../../src/context/compact/index";
import { ContextCompactor } from "../../src/context/compact/index";
import type { ApiClient } from "../../src/services/api";

const mockClient: ApiClient = { type: "mock" };

function toolMessages(): any[] {
  return [
    { role: "user", content: "改一下登录逻辑" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我先读文件" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容……" }],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test -- auth" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "Tests: 12 passed" }],
    },
    { role: "assistant", content: "已修好 token 过期分支。" },
    { role: "user", content: "很好，继续" },
    { role: "assistant", content: "完成。" },
  ];
}

function pad(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `第 ${i} 轮 ${"文本 ".repeat(20)}`,
  }));
}

describe("摘要 prompt 三要素", () => {
  it("SUMMARY_SYSTEM 要求保留文件路径/命令/结论", () => {
    expect(SUMMARY_SYSTEM).toContain("文件路径");
    expect(SUMMARY_SYSTEM).toContain("命令");
    expect(SUMMARY_SYSTEM).toContain("结论");
  });
});

describe("extractToolClues 线索抽取", () => {
  it("抽取工具名 + 关键入参（路径/命令）", () => {
    const clues = extractToolClues(toolMessages());
    expect(clues.join("\n")).toContain("Read");
    expect(clues.join("\n")).toContain("/repo/src/auth.ts");
    expect(clues.join("\n")).toContain("npm test -- auth");
  });

  it("上限截断（最多 10 条）", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      role: "assistant" as const,
      content: [
        { type: "tool_use" as const, id: `t${i}`, name: "Bash", input: { command: `cmd-${i}` } },
      ],
    }));
    expect(extractToolClues(many).length).toBeLessThanOrEqual(10);
  });

  it("无工具块 → 空数组", () => {
    expect(extractToolClues(pad(5))).toEqual([]);
  });
});

describe("extractOldClues 旧线索回收", () => {
  it("从旧摘要的线索区段回收行", () => {
    const old = "[之前的对话摘要]\n摘要正文\n\n## 工具调用线索\n- Read(/repo/old.ts)\n- Bash(npm run lint)";
    expect(extractOldClues(old)).toEqual(["- Read(/repo/old.ts)", "- Bash(npm run lint)"]);
  });

  it("无线索区段 → 空", () => {
    expect(extractOldClues("[之前的对话摘要]\n只有正文")).toEqual([]);
  });
});

describe("二次压缩并入旧摘要", () => {
  it("首条已是摘要 → mock 标记「已并入前摘要」", async () => {
    const first = {
      role: "user" as const,
      content: "[之前的对话摘要]\n旧摘要正文（含 Read(/repo/very-old.ts) 线索）",
    };
    const toSum = [first, ...toolMessages()];
    const s = await llmSummary(mockClient, "m", toSum);
    expect(s).toContain("并入前摘要");
  });

  it("未压缩过 → 无并入标记（原样新摘要）", async () => {
    const s = await llmSummary(mockClient, "m", toolMessages());
    expect(s).not.toContain("并入前摘要");
  });

  it("autoCompactKeepClues：新摘要保留旧线索 + 新工具线索", async () => {
    const oldContent =
      "[之前的对话摘要]\n旧摘要\n\n## 工具调用线索\n- Grep(pattern=login)";
    const msgs = [
      { role: "user" as const, content: oldContent },
      ...toolMessages(),
    ];
    // 补足 >6 条才走摘要
    const out = await new ContextCompactor().autoCompact(mockClient, "m", msgs);
    const first = String(out[0].content);
    expect(first).toContain("[之前的对话摘要]");
    expect(first).toContain("## 工具调用线索");
    expect(first).toContain("Grep(pattern=login)"); // 旧线索未丢
    expect(first).toContain("Read"); // 新线索已附
  });

  it("未压缩时直接调用不改变消息（仅摘要函数本身）", async () => {
    const msgs = toolMessages();
    const out = await new ContextCompactor().autoCompact(mockClient, "m", msgs.slice(0, 4));
    expect(out).toHaveLength(4); // ≤6 条不压
  });
});

describe("autoCompactKeepClues 导出可用", () => {
  it("函数存在且行为与 autoCompact 一致地缩短", async () => {
    const msgs = [...toolMessages(), ...pad(6)];
    const out = await autoCompactKeepClues(mockClient, "m", msgs);
    expect(out.length).toBeLessThan(msgs.length);
  });
});
