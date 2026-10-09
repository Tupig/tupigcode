/**
 * E43 压缩丢弃可见记录（issue #40）
 * autoCompact/compact 落 lastCompaction / 计数与省量正确 / 格式行 / recordResult 路径
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextCompactor, estimateTokens } from "../../src/context/compact/index";
import { appStore } from "../../src/state/AppState";
import { formatCompactionLine } from "../../src/engine/compaction-meta";
import type { ApiClient } from "../../src/services/api";

const mockClient: ApiClient = { type: "mock" };

function msgs(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第 ${i} 轮 ${"内容详细 ".repeat(40)}`,
  }));
}

beforeEach(() => {
  appStore.setState((s) => ({ ...s, lastCompaction: undefined }));
});
afterEach(() => {
  appStore.setState((s) => ({ ...s, lastCompaction: undefined }));
});

describe("autoCompact 落 lastCompaction", () => {
  it("压缩成功 → before/after/tokens/at/source 全记录", async () => {
    const m = msgs(14);
    const tokensBefore = estimateTokens(m);
    const out = await new ContextCompactor().autoCompact(mockClient, "mock", m);
    expect(out.length).toBeLessThan(m.length);

    const rec = appStore.getState().lastCompaction;
    expect(rec).toBeTruthy();
    expect(rec!.before).toBe(m.length);
    expect(rec!.after).toBe(out.length);
    expect(rec!.tokensBefore).toBeGreaterThan(rec!.tokensAfter);
    expect(rec!.tokensBefore).toBeGreaterThanOrEqual(tokensBefore - 100);
    expect(rec!.source).toBe("auto");
    expect(Number.isFinite(Date.parse(rec!.at))).toBe(true);
  });

  it("≤6 条不压 → 不写记录", async () => {
    await new ContextCompactor().autoCompact(mockClient, "mock", msgs(4));
    expect(appStore.getState().lastCompaction).toBeUndefined();
  });
});

describe("compact 手动路径", () => {
  it("source=manual", async () => {
    const r = await new ContextCompactor().compact(mockClient, "mock", msgs(16), "焦点");
    expect(r.messages.length).toBeLessThan(16);
    expect(appStore.getState().lastCompaction!.source).toBe("manual");
  });
});

describe("recordResult 梯度路径", () => {
  it("阈值梯度压缩走 recordResult 也落记录", () => {
    const c = new ContextCompactor();
    const before = msgs(12);
    const after = msgs(4);
    c.recordResult(before as any, after as any, estimateTokens(before), 30_000);
    const rec = appStore.getState().lastCompaction;
    expect(rec).toBeTruthy();
    expect(rec!.before).toBe(12);
    expect(rec!.after).toBe(4);
    expect(rec!.source).toBe("auto");
  });
});

describe("formatCompactionLine", () => {
  it("输出「丢 N 条消息 / 省约 M tokens」", () => {
    appStore.setState((s) => ({
      ...s,
      lastCompaction: {
        before: 12, after: 4, tokensBefore: 9000, tokensAfter: 3000,
        source: "auto", at: new Date().toISOString(),
      },
    }));
    expect(formatCompactionLine()).toBe("丢 8 条消息 / 省约 6000 tokens");
  });

  it("无记录 → 空串（/context 不显示该段）", () => {
    expect(formatCompactionLine()).toBe("");
  });
});
