/**
 * N13 git 工具补测（refs #125）：isGitRepo / getGitStatus / autoCommit / getDiff /
 * getWorkingDiff / undoLastCommit / formatGitStatus。真 git 于 tmp 仓，无外网。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isGitRepo,
  getGitStatus,
  autoCommit,
  getDiff,
  getWorkingDiff,
  undoLastCommit,
  formatGitStatus,
} from "../../src/git/index";

const execFileAsync = promisify(execFile);
let dir: string;

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-utils-"));
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "t@e.local"]);
  await git(["config", "user.name", "t"]);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isGitRepo / 非仓库", () => {
  it("空 tmp 目录 false；init 后 true；非仓返回空串/false", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "not-repo-"));
    try {
      expect(await isGitRepo(plain)).toBe(false);
      expect(await getDiff(plain)).toBe("");
      expect(await getWorkingDiff(plain)).toBe("");
      expect(await autoCommit(plain, "m")).toBeNull();
      expect(await undoLastCommit(plain)).toBe(false);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(await isGitRepo(dir)).toBe(true);
  });
});

describe("getGitStatus / formatGitStatus", () => {
  it("分支名、staged/modifed/untracked 计数与格式化文本", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    await git(["add", "a.txt"]);
    const s1 = await getGitStatus(dir);
    expect(s1.isRepo).toBe(true);
    expect(s1.branch).toBe("main");
    expect(s1.stagedFiles.length).toBe(1);

    await git(["commit", "-q", "-m", "init"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
    const s2 = await getGitStatus(dir);
    expect(s2.hasChanges).toBe(true);
    expect(s2.modifiedFiles.length).toBe(1);
    expect(s2.untrackedFiles.length).toBe(1);

    const text = formatGitStatus(s2);
    expect(text).toContain("分支：main");
    expect(text).toContain("已修改：a.txt");
    const notRepo = formatGitStatus({ isRepo: false, hasChanges: false, stagedFiles: [], modifiedFiles: [], untrackedFiles: [] });
    expect(notRepo).toBe("不在 Git 仓库中");
  });
});

describe("autoCommit / getDiff / undoLastCommit", () => {
  it("提交返回 hash；无变更 null；workingDiff/HEAD diff；soft reset 保留变更", async () => {
    fs.writeFileSync(path.join(dir, "b.txt"), "one\n");
    const c = await autoCommit(dir, "add b");
    expect(c).not.toBeNull();
    expect(c!.hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(c!.message).toBe("add b");

    expect(await autoCommit(dir, "nothing")).toBeNull();

    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    const c2 = await autoCommit(dir, "update b");
    expect(c2).not.toBeNull();

    fs.writeFileSync(path.join(dir, "b.txt"), "three\n");
    const wd = await getWorkingDiff(dir);
    expect(wd).toContain("b.txt");

    expect(await undoLastCommit(dir)).toBe(true);
    const afterUndo = await getGitStatus(dir);
    expect(afterUndo.stagedFiles.length).toBe(1); // soft reset 回到暂存区

    const head = await getDiff(dir);
    expect(typeof head).toBe("string");
  });
});
