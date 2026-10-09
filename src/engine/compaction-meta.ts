/** engine/compactionMeta.ts — 压缩丢弃记录（issue #40） */
import { appStore, type CompactionRecord } from "../state/AppState.js";

export function setCompactionRecord(
  before: number,
  after: number,
  tokensBefore: number,
  tokensAfter: number,
  source: string,
): CompactionRecord {
  const rec: CompactionRecord = {
    before, after, tokensBefore, tokensAfter, source, at: new Date().toISOString(),
  };
  appStore.setState((s) => ({ ...s, lastCompaction: rec }));
  return rec;
}

/** 「丢 N 条消息 / 省约 M tokens」；无记录返回空串 */
export function formatCompactionLine(): string {
  const r = appStore.getState().lastCompaction;
  if (!r) return "";
  const dropped = Math.max(0, r.before - r.after);
  const saved = Math.max(0, r.tokensBefore - r.tokensAfter);
  return `丢 ${dropped} 条消息 / 省约 ${saved} tokens`;
}
