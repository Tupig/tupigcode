/**
 * providers/failover.ts — 基础设施故障回退（本地 OOM/断连/限流/过载 → 云端兜底）
 * 分类逻辑统一在 services/errors.ts（LiteLLM 思路），此处只保留 failover 语义。
 */
import type { StreamEvent } from "./api.js";
import { classifyProviderError } from "./errors.js";

export function isInfraError(err: unknown): boolean {
  return classifyProviderError(err).failoverEligible;
}

export function resolveFallback(env: NodeJS.ProcessEnv = process.env): "anthropic" | "openai" | null {
  if (env.TUPIG_FAILOVER === "off") return null;
  const hasOpenAI = !!(env.OPENAI_BASE_URL && env.OPENAI_API_KEY);
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;
  const currentIsOpenAI = hasOpenAI && !env.TUPIG_PROVIDER;
  const explicit = env.TUPIG_PROVIDER;
  if (explicit === "openai" || (currentIsOpenAI && !explicit)) {
    return hasAnthropic ? "anthropic" : null;
  }
  if (explicit === "anthropic" || hasAnthropic) {
    return hasOpenAI ? "openai" : null;
  }
  return null;
}

/**
 * 兜底请求的模型名（issue #98）：config.fallbackModel 优先，缺省按兜底 provider
 * 解析默认云模型——本地模型名（14b/8b）发往云端必 404，兜底不能沿用主源模型。
 * 对齐 router.ts：anthropic → TUPIG_CLOUD_MODEL || claude-sonnet-4；openai → OPENAI_MODEL 兜底。
 */
export function resolveFallbackModel(
  label: "anthropic" | "openai",
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) return explicit;
  if (label === "anthropic") return env.TUPIG_CLOUD_MODEL || "claude-sonnet-4-20250514";
  return env.OPENAI_MODEL || env.TUPIG_CLOUD_MODEL || "claude-sonnet-4-20250514";
}

export async function* streamWithFailover(
  primary: () => AsyncGenerator<StreamEvent>,
  fallback: (() => AsyncGenerator<StreamEvent>) | null,
  label: string | null,
  onFallback?: (label: string) => void,
  onReset?: () => void | Promise<void>,
): AsyncGenerator<StreamEvent> {
  try {
    yield* primary();
  } catch (err) {
    // 中断（issue #98）：AbortError 不是基础设施故障，不切兜底流
    if ((err as any)?.name === "AbortError" || (err as any)?.code === "ABORT_ERR") throw err;
    if (!isInfraError(err) || !fallback || !label) throw err;
    // 部分产出后切换（issue #97）：先让消费方回滚已累计的文本/工具缓冲，
    // 再重放兜底流——否则 fullText 重复、残留的半个 tool_use 无法配对
    await onReset?.();
    onFallback?.(label);
    yield* fallback();
  }
}
