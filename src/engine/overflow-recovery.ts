/**
 * engine/overflowRecovery.ts — 上下文溢出自动恢复（issue #24）
 *
 * API 返回 context_too_long（prompt is too long 等）→ 不再直接报错：
 * 走既有压缩流水线重建 messages 后重试本轮，限 2 次，超出才抛。
 * 与 max_tokens 输出升级互不干扰（各走各的闸门）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { classifyProviderError } from "../services/errors.js";
import type { ApiClient } from "../services/api.js";
import type { ContextCompactor } from "../context/compact/index.js";

export const MAX_OVERFLOW_RETRIES = 2;

export function isContextOverflow(err: unknown): boolean {
  return classifyProviderError(err).kind === "context_too_long";
}

export class OverflowRecovery {
  attempts = 0;

  reset(): void {
    this.attempts = 0;
  }

  /** 是否允许为 err 再压缩重试一次（仅上下文溢出，限 MAX_OVERFLOW_RETRIES） */
  shouldRetry(err: unknown): boolean {
    if (!isContextOverflow(err)) return false;
    if (this.attempts >= MAX_OVERFLOW_RETRIES) return false;
    this.attempts++;
    return true;
  }

  /** 走既有压缩流水线重建 messages；失败回退 budgetReduction（compactor 内部兜底） */
  async recover(
    compactor: ContextCompactor,
    client: ApiClient,
    model: string,
    messages: Anthropic.MessageParam[],
  ): Promise<Anthropic.MessageParam[]> {
    try {
      return await compactor.autoCompact(client, model, messages, undefined, "overflow");
    } catch {
      return messages;
    }
  }
}
