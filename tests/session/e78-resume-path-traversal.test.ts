/**
 * e78: sessionId 路径穿越防护（issue #90）
 *
 * /resume <id> 的 id 直接拼进 sessions 路径——含 "/" 即越界读写。
 * 底层四入口（load/save/rescue/clear）统一白名单校验。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSessionMessages,
  saveSessionMessages,
  rescueSessionSync,
  clearInterruptedFlag,
} from "../../src/session/session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tupig-e78-"));
  // 诱饵：workDir 根下的用户文件
  writeFileSync(join(dir, "evil.json"), JSON.stringify({ marker: "bait" }), "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bait = () => readFileSync(join(dir, "evil.json"), "utf-8");

describe("sessionId 校验（issue #90）", () => {
  it("load 越界 id 返回 null（不读到诱饵）", async () => {
    expect(await loadSessionMessages(dir, "../evil")).toBeNull();
  });

  it("save 越界 id 不覆盖诱饵", async () => {
    await saveSessionMessages(dir, "../evil", [{ role: "user", content: "x" }]);
    expect(bait()).toContain("bait");
  });

  it("rescue/clear 越界 id 不触碰诱饵、不抛", () => {
    expect(() => rescueSessionSync(dir, "../evil", [{ role: "user", content: "x" }])).not.toThrow();
    expect(() => clearInterruptedFlag(dir, "../evil")).not.toThrow();
    expect(bait()).toContain("bait");
  });

  it("合法 id 行为回归：save/load/rescue 正常", async () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    await saveSessionMessages(dir, "s-abc123", msgs);
    expect(await loadSessionMessages(dir, "s-abc123")).toHaveLength(2);
    rescueSessionSync(dir, "fork-x1", msgs);
    expect(await loadSessionMessages(dir, "fork-x1")).toHaveLength(2);
    clearInterruptedFlag(dir, "fork-x1"); // 存在则清标记，不抛
    expect(await loadSessionMessages(dir, "fork-x1")).toHaveLength(2);
  });

  it("id 为空串拒绝", async () => {
    await saveSessionMessages(dir, "", [{ role: "user", content: "x" }]);
    expect(await loadSessionMessages(dir, "")).toBeNull();
  });
});
