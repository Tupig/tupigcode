/**
 * N4 会话持久化 + resume/fork（A5）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  saveSessionMessages,
  loadSessionMessages,
  listSessions,
  forkMessages,
} from "../../src/session/session";

type Msg = { role: "user" | "assistant"; content: string };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-sess-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const msgs = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));

describe("saveSessionMessages / loadSessionMessages", () => {
  it("保存后可完整加载", async () => {
    const m = msgs(5);
    await saveSessionMessages(dir, "s1", m as any);
    const loaded = await loadSessionMessages(dir, "s1");
    expect(loaded).toEqual(m);
  });
  it("覆盖写：以最新为准", async () => {
    await saveSessionMessages(dir, "s1", msgs(3) as any);
    await saveSessionMessages(dir, "s1", msgs(7) as any);
    const loaded = await loadSessionMessages(dir, "s1");
    expect(loaded!.length).toBe(7);
  });
  it("不存在 → null", async () => {
    expect(await loadSessionMessages(dir, "nope")).toBeNull();
  });
  it("损坏文件 → null 不抛", async () => {
    fs.mkdirSync(path.join(dir, ".tupigcode", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tupigcode", "sessions", "bad.json"), "{broken");
    expect(await loadSessionMessages(dir, "bad")).toBeNull();
  });
});

describe("listSessions", () => {
  it("列出并按更新时间倒序、含预览", async () => {
    await saveSessionMessages(dir, "old", msgs(2) as any);
    await new Promise((r) => setTimeout(r, 10));
    await saveSessionMessages(dir, "new", msgs(4) as any);
    const list = await listSessions(dir);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("new");
    expect(list[0].messageCount).toBe(4);
    expect(list[0].preview).toContain("m0");
  });
  it("空 → []", async () => {
    expect(await listSessions(dir)).toEqual([]);
  });
});

describe("forkMessages", () => {
  it("截取前 n 条", () => {
    const m = msgs(10);
    expect(forkMessages(m as any, 4).length).toBe(4);
    expect((forkMessages(m as any, 4)[3] as Msg).content).toBe("m3");
  });
  it("n 越界 → 全量；n<=0 → 空", () => {
    const m = msgs(5);
    expect(forkMessages(m as any, 99).length).toBe(5);
    expect(forkMessages(m as any, 0).length).toBe(0);
  });
  it("以 user 结尾的截断原样保留", () => {
    const m = msgs(6);
    const forked = forkMessages(m as any, 5);
    expect(forked.length).toBe(5);
    expect((forked[forked.length - 1] as Msg).role).toBe("user");
  });
  it("尾部悬挂 tool_use 的 assistant 被剔除", () => {
    const m: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(forkMessages(m, 2).length).toBe(1);
    expect(forkMessages(m, 3).length).toBe(3);
  });
});
