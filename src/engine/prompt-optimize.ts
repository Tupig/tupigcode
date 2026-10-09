/**
 * promptOptimize.ts — 提示词优化（workbuddy 类）
 * 规则式结构补全（本地 8B 特征清单），不开自迭代；偏好写 prompt-style.md 供 I1/I4。
 */
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const CMD_RE = /^\/(optimize|优化)(?:\s+(.*))?$/s;

export function parseOptimizeCommand(input: string): string | null {
  const m = input.trim().match(CMD_RE);
  if (!m) return null;
  return (m[2] || "").trim();
}

const VAGUE_RE = /^(优化|弄好|搞|处理|看看|弄一下|弄下|修|改|帮忙|help|fix|improve)?[\s。!！]*$/i;
const HAS_GOAL = /(目标|背景|约束|验收|步骤|输出格式)[:：]/;

export function optimizePrompt(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (HAS_GOAL.test(text)) return text;

  const lines = text.split("\n").filter((l) => l.trim());
  const sections: string[] = [`目标：${lines[0]}`];
  if (lines.length > 1) {
    sections.push(`任务：\n${lines.slice(1).map((l) => `- ${l}`).join("\n")}`);
  }
  sections.push("约束：优先最小改动；遵循现有代码风格；不添加不必要的注释");
  sections.push("验收：改动可构建通过（tsc/测试），行为与原意图一致");
  return sections.join("\n\n");
}

export function needsClarification(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length < 6) return true;
  if (VAGUE_RE.test(p)) return true;
  return false;
}

export type PromptStyleEntry = { action: "accept" | "reject"; prompt: string; reason: string };

export function appendPromptStyle(baseDir: string, entry: PromptStyleEntry): void {
  try {
    mkdirSync(baseDir, { recursive: true });
    appendFileSync(
      join(baseDir, "prompt-style.md"),
      JSON.stringify({ ts: Date.now(), ...entry }) + "\n",
    );
  } catch { /* 记忆写失败不阻塞 */ }
}
