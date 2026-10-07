/**
 * e76: 会话身份单源（issue #88）
 *
 * REPL 局部 sessionId（生成/resume/fork）是唯一真相源；
 * adoptSessionId 同步 appStore，hook ctx / idle / /clear 均取同步后的会话值。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appStore, adoptSessionId } from "../../src/state/AppState";

describe("adoptSessionId（issue #88）", () => {
  it("同步 appStore.sessionId 为传入 id", () => {
    const id = `s-test-${Date.now().toString(36)}`;
    adoptSessionId(id);
    expect(appStore.getState().sessionId).toBe(id);
    // 与默认值区分（默认 session-<ts>-<rand>）
    expect(appStore.getState().sessionId.startsWith("session-")).toBe(false);
  });

  it("可反复切换（resume/fork 语义）", () => {
    adoptSessionId("s-a1");
    expect(appStore.getState().sessionId).toBe("s-a1");
    adoptSessionId("fork-b2");
    expect(appStore.getState().sessionId).toBe("fork-b2");
  });
});

describe("index.ts 接线（issue #88）", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src", "index.ts"), "utf-8");

  it("生成 / resume / fork 三处均同步 appStore", () => {
    const calls = src.match(/adoptSessionId\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("query options 透传 sessionId（engine hctx 与磁盘同源）", () => {
    expect(src).toMatch(/const opts = \{[^}]*sessionId/);
  });

  it("appStore.getState().sessionId 的 hook 上报点保留（自动跟随切换）", () => {
    expect(src).toMatch(/sessionId: appStore\.getState\(\)\.sessionId/);
  });
});
