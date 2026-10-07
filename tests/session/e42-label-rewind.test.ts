/**
 * E42 /rewind 按 label 回滚（issue #39）
 * label 匹配成功 / 多个同名取最新 / id 优先于 label / 都无报错
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  snapshot, listCheckpoints, rollbackCheckpoint, rewind, resolveCheckpointTarget,
} from "../../src/session/checkpoint";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-label-"));
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "init");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveCheckpointTarget", () => {
  it("id 精确优先于 label", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    const c1 = await snapshot(dir, "同名");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3");
    const c2 = await snapshot(dir, "别名");
    const recs = await listCheckpoints(dir);
    const r1 = resolveCheckpointTarget(recs, c1!.id);
    expect(r1!.matchedBy).toBe("id");
    expect(r1!.target.id).toBe(c1!.id);
    // 即使 label 也叫「同名」的记录存在，id 仍优先
    const r2 = resolveCheckpointTarget(recs, c2!.id);
    expect(r2!.target.label).toBe("别名");
  });

  it("label 精确匹配（id 不存在时）", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "登录修复");
    const recs = await listCheckpoints(dir);
    const r = resolveCheckpointTarget(recs, "登录修复");
    expect(r).not.toBeNull();
    expect(r!.matchedBy).toBe("label");
    expect(r!.target.label).toBe("登录修复");
  });

  it("多个同名 label → 取最新（recs 倒序首个）", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "重复");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3");
    const second = await snapshot(dir, "重复");
    const recs = await listCheckpoints(dir);
    const r = resolveCheckpointTarget(recs, "重复");
    expect(r!.target.id).toBe(second!.id);
  });

  it("都无 → null", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "某点");
    const recs = await listCheckpoints(dir);
    expect(resolveCheckpointTarget(recs, "不存在的")).toBeNull();
    expect(resolveCheckpointTarget([], "x")).toBeNull();
  });
});

describe("回滚入口接受 id-or-label", () => {
  it("rollbackCheckpoint 按 label 成功，message 提示按名称", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    const c = await snapshot(dir, "目标点");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3");
    const r = await rollbackCheckpoint(dir, "目标点");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("按名称");
    expect(r.message).toContain(c!.id);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("v2");
  });

  it("rewind 按 label 成功（code 档）", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "第二点");
    fs.writeFileSync(path.join(dir, "a.txt"), "v3");
    const r = await rewind(dir, "第二点", "code");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("第二点");
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("v2");
  });

  it("都无 → 不存在报错", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    await snapshot(dir, "x");
    const r = await rewind(dir, "无此点", "code");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("检查点不存在");
  });
});
