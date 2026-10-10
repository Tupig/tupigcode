/**
 * e79: 会话文件原子写（issue #90）
 *
 * save/prune 走 temp+rename：rename 失败（模拟中断）时原文件保持完好，
 * 不出现半写截断。rescue（信号处理器内）走同步原子版。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rename } from "fs/promises";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    // 初始实现绑定真 rename（mockClear 只清计数不重置实现）
    rename: vi.fn(actual.rename),
  };
});

const renameMock = vi.mocked(rename);

const { saveSessionMessages, loadSessionMessages } = await import("../../src/session/session");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tupig-e79-"));
  renameMock.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("原子写（issue #90）", () => {
  it("正常路径：经 rename 落盘且内容正确（接线断言）", async () => {
    await saveSessionMessages(dir, "s-a1", [{ role: "user", content: "hello" }]);
    expect(renameMock).toHaveBeenCalledTimes(1);
    const msgs = await loadSessionMessages<{ role: string }>(dir, "s-a1");
    expect(msgs).toHaveLength(1);
  });

  it("rename 失败：原文件保持旧内容且错误上抛（不半写）", async () => {
    // 先落一份旧内容
    await saveSessionMessages(dir, "s-a1", [{ role: "user", content: "OLD" }]);
    const path = join(dir, ".tupigcode", "sessions", "s-a1.json");
    const before = readFileSync(path, "utf-8");

    renameMock.mockRejectedValueOnce(new Error("EIO injected"));
    await expect(
      saveSessionMessages(dir, "s-a1", [{ role: "user", content: "NEW-CONTENT" }]),
    ).rejects.toThrow("EIO injected");

    expect(readFileSync(path, "utf-8")).toBe(before); // 旧文件完好
  });

  it("接线：rescue 同步原子版、prune jsonl 原子写", () => {
    const sessionSrc = readFileSync(join(__dirname, "..", "..", "src", "session", "session.ts"), "utf-8");
    expect(sessionSrc).toMatch(/writeFileAtomic\(/);
    expect(sessionSrc).toMatch(/writeFileAtomicSync\(/);
    const ckptSrc = readFileSync(join(__dirname, "..", "..", "src", "session", "checkpoint.ts"), "utf-8");
    expect(ckptSrc).toMatch(/writeFileAtomic\(/);
  });
});

describe("tmp 并发与失败清理（fix #121）", () => {
  it("async 与 sync 并发写同一目标：最终为完整 JSON，无半写", async () => {
    const { writeFileAtomic, writeFileAtomicSync } = await import("../../src/utils/atomic-write");
    const target = join(dir, "hot.json");
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const payload = JSON.stringify({ w: i, pad: "x".repeat(4096) });
      if (i % 2 === 0) jobs.push(writeFileAtomic(target, payload));
      else jobs.push(Promise.resolve().then(() => writeFileAtomicSync(target, payload)));
    }
    await Promise.all(jobs);
    const final = JSON.parse(readFileSync(target, "utf-8")) as { w: number };
    expect(typeof final.w).toBe("number");
    // 成功路径不留 tmp 残渣
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("写失败：异常抛出且不留半写目标", async () => {
    const { writeFileAtomic } = await import("../../src/utils/atomic-write");
    const target = join(dir, "missing-dir", "f.txt");
    await expect(writeFileAtomic(target, "x")).rejects.toThrow();
  });
});
