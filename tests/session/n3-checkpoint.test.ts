/**
 * N3 会话检查点（A4）：git 快照 + 回滚
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { snapshot, listCheckpoints, rollbackCheckpoint } from "../../src/session/checkpoint";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-ckpt-"));
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "init");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("snapshot 快照", () => {
  it("有改动 → 创建检查点并记录 jsonl", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
    const r = await snapshot(dir, "改了a");
    expect(r).not.toBeNull();
    expect(r!.label).toBe("改了a");
    expect(r!.sha).toMatch(/^[0-9a-f]{7,40}$/);
    const list = await listCheckpoints(dir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(r!.id);
  });
  it("无改动 → null", async () => {
    const r = await snapshot(dir, "空转");
    expect(r).toBeNull();
  });
  it("多次快照按时间倒序列出", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "第一");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3");
    await snapshot(dir, "第二");
    const list = await listCheckpoints(dir);
    expect(list.length).toBe(2);
    expect(list[0].label).toBe("第二");
  });
  it("非 git 目录 → null", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-plain-"));
    const r = await snapshot(plain, "x");
    fs.rmSync(plain, { recursive: true, force: true });
    expect(r).toBeNull();
  });
});

describe("rollbackCheckpoint 回滚", () => {
  it("回滚到检查点 → 文件内容恢复", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2-changed");
    const ck = await snapshot(dir, "v2点");
    expect(ck).not.toBeNull();
    fs.writeFileSync(path.join(dir, "a.txt"), "v3-discard");
    const r = await rollbackCheckpoint(dir, ck!.id);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toContain("v2-changed");
  });
  it("回滚前自动生成安全检查点", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    const ck = await snapshot(dir, "v2点");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3-unsafe");
    await rollbackCheckpoint(dir, ck!.id);
    const list = await listCheckpoints(dir);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].label).toMatch(/安全|safety/);
  });
  it("不存在的 id → ok:false", async () => {
    const r = await rollbackCheckpoint(dir, "nope-123");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/不存在/);
  });
});

// ---------- issue #14：自动快照 + /rewind 三档 ----------
import { snapshotWithMessages, rewind, autoSnapshot, pruneCheckpoints } from "../../src/session/checkpoint";

describe("自动快照（TUPIG_AUTOSNAPSHOT）", () => {
  it("有改动 → 创建快照并保存消息快照文件", async () => {
    fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
    const msgs = [{ role: "user" as const, content: "hello" }];
    const rec = await snapshotWithMessages(dir, "auto:turn", msgs);
    expect(rec).not.toBeNull();
    const msgFile = path.join(dir, ".tupigcode", "msg-snap", `${rec!.id}.json`);
    expect(fs.existsSync(msgFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(msgFile, "utf-8"))).toEqual(msgs);
  });

  it("autoSnapshot 防抖：5s 内二次调用不建新快照", async () => {
    fs.writeFileSync(path.join(dir, "c.txt"), "x1\n");
    const r1 = await autoSnapshot(dir, "auto:tool", []);
    expect(r1).not.toBeNull();
    fs.writeFileSync(path.join(dir, "c.txt"), "x2\n");
    const r2 = await autoSnapshot(dir, "auto:tool", []);
    expect(r2).toBeNull(); // 防抖窗口内
  });

  it("无改动 / 非 git → null 静默", async () => {
    expect(await autoSnapshot(dir, "auto:tool", [])).toBeNull();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "notgit-"));
    try {
      expect(await autoSnapshot(bare, "auto:tool", [])).toBeNull();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("rewind 三档", () => {
  async function makePoint(): Promise<string> {
    fs.writeFileSync(path.join(dir, "w.txt"), "before\n");
    const rec = await snapshotWithMessages(dir, "rewind-test", [
      { role: "user" as const, content: "old-1" },
      { role: "assistant" as const, content: "old-2" },
    ]);
    fs.writeFileSync(path.join(dir, "w.txt"), "after\n");
    fs.writeFileSync(path.join(dir, "n.txt"), "added\n");
    return rec!.id;
  }

  it("code 档：文件恢复、不回卷消息", async () => {
    const id = await makePoint();
    const r = await rewind(dir, id, "code");
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "w.txt"), "utf-8")).toBe("before\n");
    expect(fs.existsSync(path.join(dir, "n.txt"))).toBe(false);
    expect(r.messages).toBeUndefined();
  });

  it("chat 档：消息回卷、文件不动", async () => {
    const id = await makePoint();
    const r = await rewind(dir, id, "chat");
    expect(r.ok).toBe(true);
    expect(r.messages).toHaveLength(2);
    expect(r.messages![0].content).toBe("old-1");
    expect(fs.readFileSync(path.join(dir, "w.txt"), "utf-8")).toBe("after\n"); // 文件未动
    expect(fs.existsSync(path.join(dir, "n.txt"))).toBe(true);
  });

  it("all 档：文件与消息都恢复", async () => {
    const id = await makePoint();
    const r = await rewind(dir, id, "all");
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "w.txt"), "utf-8")).toBe("before\n");
    expect(fs.existsSync(path.join(dir, "n.txt"))).toBe(false);
    expect(r.messages).toHaveLength(2);
  });

  it("不存在 id → ok:false", async () => {
    const r = await rewind(dir, "nope-000", "all");
    expect(r.ok).toBe(false);
  });
});

describe("检查点上限清理", () => {
  it("超过 N → 滚动保留最新 N 个（jsonl + ref + 消息文件）", async () => {
    const made: string[] = [];
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(dir, "auto.txt"), `v${i}\n`);
      const rec = await snapshotWithMessages(dir, `auto:${i}`, []);
      if (rec) made.push(rec.id);
    }
    const before = await listCheckpoints(dir);
    expect(before.length).toBeLessThanOrEqual(25);

    await pruneCheckpoints(dir, 20);
    const after = await listCheckpoints(dir);
    expect(after.length).toBe(20);
    // 最早的被清、最新保留
    expect(after[0].id).toBe(made[made.length - 1]); // 倒序列表：最新在前
    const removed = made.slice(0, made.length - 20);
    for (const id of removed) {
      expect(fs.existsSync(path.join(dir, ".tupigcode", "msg-snap", `${id}.json`))).toBe(false);
      let hasRef = true;
      try {
        execFileSync("git", ["rev-parse", "--verify", `refs/tupigcode/checkpoints/${id}`], { cwd: dir, stdio: "pipe" });
      } catch {
        hasRef = false;
      }
      expect(hasRef).toBe(false);
    }
  }, 30_000);
});
