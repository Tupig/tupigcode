/**
 * utils/truncationHint.ts — 截断续取交接提示（issue #56）
 *
 * 截断处统一带「已截断 total=N，本次显示 x~y，用 offset/limit 续取」，
 * 让模型有明确的下一步参数，而不是瞎重试。
 */

export type TruncationHintInput = {
  total: number;
  shown: number;
  offset?: number;
  limit?: number;
  /** 计数单位（默认「条」，字符流用「字符」） */
  unit?: string;
  /** 续取参数名（默认 offset / head_limit） */
  offsetParam?: string;
  limitParam?: string;
};

export function truncationHint(input: TruncationHintInput): string {
  const offset = input.offset ?? 0;
  const unit = input.unit ?? "条";
  const shown = input.shown;
  const from = offset + 1;
  const to = offset + shown;
  const next = offset + shown;
  const offsetParam = input.offsetParam ?? "offset";
  const limitParam = input.limitParam ?? "head_limit";
  const limitPart = input.limit !== undefined ? ` & ${limitParam}=${input.limit}` : "";
  const range = shown > 0 ? `${from}~${to}${unit}` : `0${unit}`;
  return `（已截断：total=${input.total}${unit}，本次显示 ${range}；`
    + `用 ${offsetParam}=${next}${limitPart} 续取后续）`;
}
