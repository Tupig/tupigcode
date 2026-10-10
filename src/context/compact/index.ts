/**
 * compact/index.ts — 上下文压缩 5 阶段流水线
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ApiClient } from "../../services/api.js";
import { chatUrl } from "../../services/api.js";
import { ADAPTIVE_ITERATIONS_CAP, DEFAULT_MAX_CONTEXT_TOKENS, TOKEN_BYTES_PER_TOKEN } from "../../engine/constants.js";
import { setCompactionRecord } from "../../engine/compaction-meta.js";

const SUMMARY_MAX_TOKENS = 768;
const SUMMARY_TIMEOUT_MS = 30_000;
export const SUMMARY_SYSTEM =
  "请简洁地总结对话历史，保留关键决策、代码变更和上下文信息；必须显式保留文件路径、关键命令与结果结论三要素。";

/**
 * 对话历史 LLM 摘要（三链路统一入口）。
 * openai（本地主链路）非流式 chat/completions、独立短超时；anthropic 走 messages.create；mock 返回固定串。
 * 失败抛错，由调用方决定回退策略。
 */
const CLUE_MAX = 10;
const CLUE_SECTION = "## 工具调用线索";
const CLUE_PARAM_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "script"];

export function isSummaryContent(content: unknown): boolean {
  return typeof content === "string" && content.startsWith("[之前的对话摘要]");
}

function briefInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of CLUE_PARAM_KEYS) {
    if (typeof obj[k] === "string" && obj[k]) return String(obj[k]);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** 抽取消息中的工具调用线索：`- name(brief)`，去重 + 上限 */
export function extractToolClues(messages: Anthropic.MessageParam[], max = CLUE_MAX): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type !== "tool_use") continue;
      const line = `- ${b.name}(${briefInput(b.input)})`;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 压缩后消毒：剔除无配对的 tool_result，未被下一步 user 消费的 tool_use 以占位文本替换
 * （fix #119——snip/microcompact/contextCollapse 切片会破坏配对，API 对悬挂块直接 400 且不可重试）
 */
export function sanitizeToolPairing(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const isObj = (b: unknown): b is Record<string, unknown> =>
    typeof b === "object" && b !== null;
  const useIdsOf = (m: Anthropic.MessageParam): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as unknown[])
      .filter((b): b is Record<string, unknown> => isObj(b) && b["type"] === "tool_use" && typeof b["id"] === "string")
      .map((b) => b["id"] as string);
  };
  const resultIdsOf = (m: Anthropic.MessageParam): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as unknown[])
      .filter(
        (b): b is Record<string, unknown> =>
          isObj(b) && b["type"] === "tool_result" && typeof b["tool_use_id"] === "string",
      )
      .map((b) => b["tool_use_id"] as string);
  };

  const removeIds = new Set<string>();
  const seenUse = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const useIds = msg.role === "assistant" ? useIdsOf(msg) : [];
    for (const id of useIds) seenUse.add(id);
    if (useIds.length > 0) {
      const next = messages[i + 1];
      const got = next !== undefined && next.role === "user" ? new Set(resultIdsOf(next)) : new Set<string>();
      for (const id of useIds) if (!got.has(id)) removeIds.add(id);
    }
    if (msg.role === "user") {
      for (const id of resultIdsOf(msg)) if (!seenUse.has(id)) removeIds.add(id);
    }
  }
  if (removeIds.size === 0) return messages;

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let touched = false;
    const content: unknown[] = [];
    for (const b of msg.content as unknown[]) {
      if (isObj(b) && b["type"] === "tool_use" && typeof b["id"] === "string" && removeIds.has(b["id"])) {
        touched = true;
        content.push({ type: "text", text: "[已省略被截断的工具调用]" });
        continue;
      }
      if (isObj(b) && b["type"] === "tool_result" && typeof b["tool_use_id"] === "string" && removeIds.has(b["tool_use_id"])) {
        touched = true;
        continue;
      }
      content.push(b);
    }
    if (!touched) return msg;
    if (content.length === 0) {
      content.push({ type: "text", text: msg.role === "user" ? "[工具结果已省略]" : "[已省略]" });
    }
    return { ...msg, content } as Anthropic.MessageParam;
  });
}

/** 从旧摘要文本回收线索区段行（二次压缩时保留） */
export function extractOldClues(content: string, max = CLUE_MAX): string[] {
  const idx = content.indexOf(CLUE_SECTION);
  if (idx < 0) return [];
  return content
    .slice(idx + CLUE_SECTION.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .slice(0, max);
}

export async function llmSummary(
  client: ApiClient, model: string, toSummarize: Anthropic.MessageParam[], focus?: string,
): Promise<string> {
  const focusHint = focus?.trim() ? `，重点关注：${focus.trim()}` : "";
  const chained = isSummaryContent(toSummarize[0]?.content);
  const chainPart = chained ? `前次摘要（须并入新摘要，不得丢弃）：\n${String(toSummarize[0].content)}\n\n` : "";
  const userContent = `${chainPart}请总结以下对话${focusHint}：\n${JSON.stringify(chained ? toSummarize.slice(1) : toSummarize, null, 2)}`;

  if (client.type === "anthropic" && client.anthropic) {
    // 超时兜底（issue #91）：与 openai 链路同款 30s，防摘要挂起卡死主循环
    const resp = await client.anthropic.messages.create(
      {
        model: model || "claude-haiku-4-20250414",
        max_tokens: SUMMARY_MAX_TOKENS,
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: userContent }],
      },
      { signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS) },
    );
    return resp.content[0]?.type === "text" ? resp.content[0].text : "";
  }

  if (client.type === "mock") {
    return chained
      ? `（mock 链路摘要${focusHint}·已并入前摘要：此前对话已折叠）`
      : `（mock 链路摘要${focusHint}：此前对话已折叠）`;
  }

  if (client.type === "openai") {
    const base = process.env.OPENAI_BASE_URL;
    const key = process.env.OPENAI_API_KEY;
    if (!base || !key) throw new Error("摘要失败：OPENAI_BASE_URL / OPENAI_API_KEY 未设置");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const resp = await fetch(chatUrl(base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SUMMARY_SYSTEM },
            { role: "user", content: userContent },
          ],
          max_tokens: SUMMARY_MAX_TOKENS,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`摘要请求返回 ${resp.status}：${await resp.text()}`);
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`不支持的 provider：${client.type}`);
}

export interface CompactionConfig {
  threshold: number;
  maxMessages: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 0.85,
  maxMessages: 100,
};

export type Strategy =
  | "none"
  | "micro"
  | "snip"
  | "collapse"
  | "force"
  | "circuit-open";

export const LADDER_MICRO = 0.6;
const LADDER_SNIP = 0.7;
const LADDER_COLLAPSE = 0.85;
const LADDER_FORCE = 0.95;

export function pickStrategy(usage: number, messageCount: number, maxTokens = DEFAULT_MAX_CONTEXT_TOKENS): Strategy {
  const maxMessages = Math.max(100, Math.floor(maxTokens / 1000));
  if (messageCount > maxMessages) return "force";
  if (usage > LADDER_FORCE) return "force";
  if (usage > LADDER_COLLAPSE) return "collapse";
  if (usage > LADDER_SNIP) return "snip";
  if (usage > LADDER_MICRO) return "micro";
  return "none";
}

export function adaptiveIterations(_estimatedTokens: number, maxTokens: number): number {
  return Math.min(ADAPTIVE_ITERATIONS_CAP, Math.max(5, Math.ceil(maxTokens / 2_000_000) * 5));
}

export function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / TOKEN_BYTES_PER_TOKEN);
}

export class ContextCompactor {
  private config: CompactionConfig;
  private circuitOpen = false;
  private lastOriginal: Anthropic.MessageParam[] | null = null;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  getLastOriginal(): Anthropic.MessageParam[] | null {
    return this.lastOriginal;
  }

  recordResult(
    before: Anthropic.MessageParam[],
    after: Anthropic.MessageParam[],
    _beforeTokens: number,
    _maxTokens: number,
  ): void {
    this.lastOriginal = before;
    if (estimateTokens(after) >= estimateTokens(before)) {
      this.circuitOpen = true;
    }
    setCompactionRecord(before.length, after.length, _beforeTokens, estimateTokens(after), "auto");
  }

  compactByLadder(
    messages: Anthropic.MessageParam[],
    estimatedTokens: number,
    maxTokens: number,
  ): { messages: Anthropic.MessageParam[]; strategy: Strategy } {
    if (this.circuitOpen) return { messages, strategy: "circuit-open" };
    const strategy = pickStrategy(estimatedTokens / maxTokens, messages.length, maxTokens);
    this.lastOriginal = messages;
    const hit = (m: Anthropic.MessageParam[], s: Strategy): { messages: Anthropic.MessageParam[]; strategy: Strategy } =>
      s === "none" ? { messages: m, strategy: s } : { messages: sanitizeToolPairing(m), strategy: s };
    switch (strategy) {
      case "none":
        return { messages, strategy };
      case "micro":
        return hit(this.microcompact(messages), strategy);
      case "snip":
        return hit(this.snip(messages), strategy);
      case "collapse":
      case "force":
        return hit(this.contextCollapse(messages), strategy);
      default:
        return { messages, strategy: "none" };
    }
  }

  compactToBudget(
    messages: Anthropic.MessageParam[],
    estimatedTokens: number,
    maxTokens: number,
    maxIterations?: number,
  ): { messages: Anthropic.MessageParam[]; iterations: number } {
    const limit = maxIterations ?? adaptiveIterations(estimatedTokens, maxTokens);
    if (estimatedTokens <= maxTokens) return { messages, iterations: 0 };
    this.lastOriginal = messages;
    let current = messages;
    let currentTokens = estimatedTokens;
    let iterations = 0;
    while (currentTokens > maxTokens && iterations < limit && current.length > 4) {
      const r = this.compactByLadder(current, currentTokens, maxTokens);
      if (r.strategy === "none" || r.strategy === "circuit-open") break;
      if (r.messages.length >= current.length && r.strategy !== "snip") break;
      current = r.messages;
      currentTokens = estimateTokens(current);
      iterations++;
    }
    if (currentTokens > maxTokens) {
      this.lastOriginal = messages;
      current = this.budgetReduction(messages);
      iterations++;
    }
    return { messages: sanitizeToolPairing(current), iterations };
  }

  shouldCompact(messages: Anthropic.MessageParam[], estimatedTokens: number, maxTokens: number): boolean {
    const usage = estimatedTokens / maxTokens;
    return usage > this.config.threshold || messages.length > this.config.maxMessages;
  }

  budgetReduction(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 4) return messages;
    // keep_first：首条是主任务指令，绝不能丢（A14）
    return [messages[0], ...messages.slice(-3)];
  }

  snip(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 6) return messages;
    return messages.map((msg, idx) => {
      if (idx < 2 || idx >= messages.length - 2) return msg;
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasToolResults = msg.content.some((b: any) => b.type === "tool_result");
        if (hasToolResults) {
          return { ...msg, content: [{ type: "text" as const, text: "[工具结果已截断以节省上下文空间]" }] };
        }
      }
      return msg;
    });
  }

  microcompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 8) return messages;
    const head = messages.slice(0, 2);
    const tail = messages.slice(-4);
    const middle = messages.slice(2, -4);
    if (middle.length > 3) {
      const compacted = [...middle.slice(0, 2), middle[middle.length - 1]];
      return [...head, ...compacted, ...tail];
    }
    return messages;
  }

  contextCollapse(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 10) return messages;
    const head = messages.slice(0, 2);
    const tail = messages.slice(-6);
    const middle = messages.slice(2, -6);
    if (middle.length === 0) return messages;

    const headEndsWithAssistant = head.length > 0 && head[head.length - 1].role === "assistant";

    const collapsed: Anthropic.MessageParam[] = [];
    if (headEndsWithAssistant) {
      collapsed.push({ role: "user", content: `[上下文已折叠：省略了 ${middle.length} 条消息]` });
    } else {
      collapsed.push({ role: "user", content: `[上下文已折叠：省略了 ${middle.length} 条消息]` });
      collapsed.push({ role: "assistant", content: "已收到折叠上下文中的信息。" });
    }

    return [...head, ...collapsed, ...tail];
  }

  async autoCompact(
    client: ApiClient, model: string, messages: Anthropic.MessageParam[], focus?: string,
    source = "auto",
  ): Promise<Anthropic.MessageParam[]> {
    if (messages.length <= 6) return messages;

    const recent = messages.slice(-6);
    const toSummarize = messages.slice(0, -6);
    if (toSummarize.length === 0) return messages;

    try {
      const summary = await llmSummary(client, model, toSummarize, focus);
      if (!summary) throw new Error("空摘要");
      const oldContent = isSummaryContent(toSummarize[0]?.content)
        ? String(toSummarize[0].content)
        : "";
      const clues = [
        ...extractOldClues(oldContent),
        ...extractToolClues(toSummarize),
      ].filter((c, i, arr) => arr.indexOf(c) === i).slice(0, CLUE_MAX);
      const clueBlock = clues.length ? `\n\n${CLUE_SECTION}\n${clues.join("\n")}` : "";
      const outMsgs = [
        { role: "user", content: `[之前的对话摘要]\n${summary}${clueBlock}` },
        { role: "assistant", content: "已收到之前对话的上下文。" },
        ...recent,
      ] as Anthropic.MessageParam[];
      setCompactionRecord(
        messages.length, outMsgs.length, estimateTokens(messages), estimateTokens(outMsgs), source,
      );
      return sanitizeToolPairing(outMsgs);
    } catch {
      const fb = this.budgetReduction(messages);
      if (fb.length < messages.length) {
        setCompactionRecord(
          messages.length, fb.length, estimateTokens(messages), estimateTokens(fb), source,
        );
      }
      return sanitizeToolPairing(fb);
    }
  }

  async compact(
    client: ApiClient, model: string, messages: Anthropic.MessageParam[], focus?: string,
    source = "manual",
  ): Promise<{ messages: Anthropic.MessageParam[]; strategy: string }> {
    const rec = (out: Anthropic.MessageParam[]) =>
      setCompactionRecord(
        messages.length, out.length, estimateTokens(messages), estimateTokens(out), source,
      );

    const afterSnip = this.snip(messages);
    if (JSON.stringify(afterSnip) !== JSON.stringify(messages)) {
      rec(afterSnip);
      return { messages: sanitizeToolPairing(afterSnip), strategy: "snip" };
    }

    const afterMicro = this.microcompact(messages);
    if (afterMicro.length < messages.length) {
      rec(afterMicro);
      return { messages: sanitizeToolPairing(afterMicro), strategy: "microcompact" };
    }

    const afterCollapse = this.contextCollapse(messages);
    if (afterCollapse.length < messages.length) {
      rec(afterCollapse);
      return { messages: sanitizeToolPairing(afterCollapse), strategy: "context-collapse" };
    }

    const afterAuto = await this.autoCompact(client, model, messages, focus, source);
    return { messages: afterAuto, strategy: "auto-compact" };
  }
}

/** 便捷包装：带工具调用线索保留的自动压缩（issue #30） */
export async function autoCompactKeepClues(
  client: ApiClient, model: string, messages: Anthropic.MessageParam[], focus?: string,
): Promise<Anthropic.MessageParam[]> {
  return new ContextCompactor().autoCompact(client, model, messages, focus);
}
