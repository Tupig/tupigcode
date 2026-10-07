/**
 * E30 SIGINT 会话同步落盘（issue #27）
 * interrupted 标记落盘 / 启动检测孤儿会话 / 正常结束清除 / 同步写盘 / 空会话不写
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  saveSessionMessages,
  loadSessionMessages,
  listInterruptedSessions,
  clearInterruptedFlag,
  rescueSessionSync,
  formatInterruptedNotice,
} from "../../src/session/session";

let dir = "";
const SID = "s-rescue";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rescue-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第 ${i} 轮` }));

describe("interrupted 标记", () => {
  it("带 interrupted 落盘 → listInterruptedSessions 能找到", async () => {
    await saveSessionMessages(dir, SID, msgs(3), { interrupted: true });
    const list = listInterruptedSessions(dir);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(SID);
    expect(list[0].messageCount).toBe(3);
  });

  it("正常落盘（无标记）→ 不在孤儿列表", async () => {
    await saveSessionMessages(dir, SID, msgs(3));
    expect(listInterruptedSessions(dir)).toHaveLength(0);
  });

  it("正常 turn 结束再保存 → 冲掉旧标记（先 interrupted 后 normal）", async () => {
    await saveSessionMessages(dir, SID, msgs(2), { interrupted: true });
    await saveSessionMessages(dir, SID, msgs(4));
    expect(listInterruptedSessions(dir)).toHaveLength(0);
    const loaded = await loadSessionMessages(dir, SID);
    expect(loaded).toHaveLength(4);
  });

  it("clearInterruptedFlag 手动清除", async () => {
    await saveSessionMessages(dir, SID, msgs(2), { interrupted: true });
    clearInterruptedFlag(dir, SID);
    expect(listInterruptedSessions(dir)).toHaveLength(0);
  });

  it("标记不影响 loadSessionMessages 返回内容", async () => {
    await saveSessionMessages(dir, SID, msgs(5), { interrupted: true });
    const loaded = await loadSessionMessages(dir, SID);
    expect(loaded).toHaveLength(5);
  });

  it("损坏的会话文件不炸（跳过）", async () => {
    const { mkdirSync } = await import("fs");
    mkdirSync(join(dir, ".tupigcode", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "sessions", "bad.json"), "{oops");
    expect(() => listInterruptedSessions(dir)).not.toThrow();
  });
});

describe("rescueSessionSync 同步落盘", () => {
  it("SIGINT 路径：同步写盘含标记", () => {
    rescueSessionSync(dir, SID, msgs(3));
    const raw = JSON.parse(readFileSync(join(dir, ".tupigcode", "sessions", `${SID}.json`), "utf-8"));
    expect(raw.interrupted).toBe(true);
    expect(raw.messages).toHaveLength(3);
    expect(listInterruptedSessions(dir)).toHaveLength(1);
  });

  it("空消息 → 不写文件", () => {
    rescueSessionSync(dir, SID, []);
    expect(existsSync(join(dir, ".tupigcode", "sessions", `${SID}.json`))).toBe(false);
  });
});

describe("启动检测提示", () => {
  it("有孤儿 → 返回含 id 与条数的提示", async () => {
    await saveSessionMessages(dir, SID, msgs(7), { interrupted: true });
    const notice = formatInterruptedNotice(listInterruptedSessions(dir));
    expect(notice).toContain(SID);
    expect(notice).toContain("7");
    expect(notice).toContain("/resume");
  });

  it("无孤儿 → 空串", () => {
    expect(formatInterruptedNotice([])).toBe("");
  });
});
