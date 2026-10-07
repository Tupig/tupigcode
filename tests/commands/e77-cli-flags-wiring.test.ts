/**
 * e77: CLI 运行参数接线（issue #89）
 *
 * -t/--max-tokens、--max-turns、-w/--work-dir 解析后必须进 appStore，
 * 并被 query options 消费（此前声明未接线，--help 与行为不符）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appStore, defaultAppState } from "../../src/state/AppState";

describe("运行参数默认值（issue #89）", () => {
  it("defaultAppState 携带 maxTurns/maxTokens 默认", () => {
    expect(defaultAppState.maxTurns).toBe(20);
    expect(defaultAppState.maxTokens).toBe(8192);
  });

  it("setState 可写入运行参数", () => {
    const prev = { turns: appStore.getState().maxTurns, tokens: appStore.getState().maxTokens };
    appStore.setState((s) => ({ ...s, maxTurns: 7, maxTokens: 1234 }));
    expect(appStore.getState().maxTurns).toBe(7);
    expect(appStore.getState().maxTokens).toBe(1234);
    appStore.setState((s) => ({ ...s, maxTurns: prev.turns, maxTokens: prev.tokens }));
  });
});

describe("index.ts 接线（issue #89）", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src", "index.ts"), "utf-8");

  it("main() 校验并写入 workDir/maxTurns/maxTokens", () => {
    expect(src).toMatch(/resolve\(String\(opts\.workDir\)\)/);
    expect(src).toMatch(/workDir, maxTurns, maxTokens/);
  });

  it("query options 消费三字段（engine cwd/轮次/输出上限）", () => {
    expect(src).toMatch(/cwd: appStore\.getState\(\)\.workDir/);
    expect(src).toMatch(/maxTurns: appStore\.getState\(\)\.maxTurns/);
    expect(src).toMatch(/maxTokens: appStore\.getState\(\)\.maxTokens/);
  });

  it("单发 runSingle 同样走 workDir 与运行参数", () => {
    const single = src.slice(src.indexOf("async function runSingle"), src.indexOf("function main"));
    expect(single).toMatch(/cwd: appStore\.getState\(\)\.workDir/);
    expect(single).toMatch(/maxTurns: appStore\.getState\(\)\.maxTurns/);
  });
});
