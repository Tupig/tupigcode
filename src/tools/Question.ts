/**
 * tools/Question.ts — 向用户提问工具（A19）
 */
import { z } from "zod";
import { buildTool, type ToolResult } from "../engine/Tool.js";

export const QuestionInput = z.object({
  question: z.string().describe("要向用户提出的问题，一句话说清"),
  options: z.array(z.string()).optional().describe("可选项列表（可选）"),
});

export const QuestionTool = buildTool<string>({
  name: "Question",
  inputSchema: QuestionInput,
  maxResultSizeChars: Infinity,
  description: () => "向用户提问并等待文字回答。需要用户决策、缺少关键信息时使用。",
  prompt: () => "向用户提问。给出清晰的问题和可选项。",
  userFacingName: () => "Question",
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,

  async checkPermissions(input, _ctx) {
    return { behavior: "allow", updatedInput: input };
  },

  async call(input): Promise<ToolResult<string>> {
    if (!process.stdin.isTTY) {
      return { data: "错误：当前为非交互环境，无法提问。请基于已有信息继续，或在回复中直接给出你的假设。", isError: true };
    }

    console.log(`\n问题：${input.question}`);
    if (input.options?.length) {
      input.options.forEach((o: string, i: number) => console.log(`  ${i + 1}. ${o}`));
    }

    const answer = await new Promise<string>((resolve) => {
      let settled = false;
      const finish = (v: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.pause();
        resolve(v);
      };
      process.stdout.write("你的回答> ");
      process.stdin.setEncoding("utf-8");
      process.stdin.resume();
      process.stdin.once("data", (d: string) => finish(d.trim()));
      process.stdin.once("close", () => finish(""));
      process.stdin.once("end", () => finish(""));
      const timer = setTimeout(() => finish(""), 120_000);
    });

    if (!answer) return { data: "用户未回答（超时或关闭）" };
    return { data: `用户回答：${answer}` };
  },
});
