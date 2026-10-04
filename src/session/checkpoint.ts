/**
 * checkpoint.ts — 会话检查点（A4：gemini-cli shadow Git 思路）
 * 快照：commit→存 refs/tupigcode/checkpoints/<id>→mixed reset 还原用户工作区（不污染分支）
 * 回滚：先自动生成安全检查点，再硬重置到目标
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, appendFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { writeFileAtomic } from "../utils/atomicWrite.js";

const execFileAsync = promisify(execFile);

const CKPT_REF_PREFIX = "refs/tupigcode/checkpoints/";

export type CheckpointRecord = {
  id: string;
  sha: string;
  label: string;
  createdAt: string;
};

async function git(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: workDir, encoding: "utf-8" });
  return stdout.trim();
}

async function isGitRepo(workDir: string): Promise<boolean> {
  try {
    await git(workDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function jsonlPath(workDir: string): string {
  return join(workDir, ".tupigcode", "checkpoints.jsonl");
}

async function appendRecord(workDir: string, rec: CheckpointRecord): Promise<void> {
  await mkdir(join(workDir, ".tupigcode"), { recursive: true });
  await appendFile(jsonlPath(workDir), JSON.stringify(rec) + "\n", "utf-8");
}

export async function listCheckpoints(workDir: string): Promise<CheckpointRecord[]> {
  try {
    const raw = await readFile(jsonlPath(workDir), "utf-8");
    const recs = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CheckpointRecord);
    return recs.reverse();
  } catch {
    return [];
  }
}

/** 目标解析（issue #39）：id 精确优先；否则 label 精确（recs 为新→旧，首个即最新） */
export function resolveCheckpointTarget(
  recs: CheckpointRecord[],
  arg: string,
): { target: CheckpointRecord; matchedBy: "id" | "label" } | null {
  const byId = recs.find((r) => r.id === arg);
  if (byId) return { target: byId, matchedBy: "id" };
  const byLabel = recs.find((r) => r.label === arg);
  if (byLabel) return { target: byLabel, matchedBy: "label" };
  return null;
}

export async function snapshot(workDir: string, label: string): Promise<CheckpointRecord | null> {
  if (!(await isGitRepo(workDir))) return null;
  const status = await git(workDir, ["status", "--porcelain"]);
  if (!status) return null;

  const base = await git(workDir, ["rev-parse", "HEAD"]);
  await git(workDir, ["add", "-A"]);
  // 检查点是内部机制，作者无关：内联 identity，环境无全局配置时也能提交
  await git(workDir, ["-c", "user.name=tupigcode", "-c", "user.email=tupigcode@local", "commit", "-qm", `[tupigcode] ${label}`]);
  const sha = await git(workDir, ["rev-parse", "HEAD"]);
  const id = `${Date.now().toString(36)}-${sha.slice(0, 7)}`;
  await git(workDir, ["update-ref", CKPT_REF_PREFIX + id, sha]);
  await git(workDir, ["reset", "-q", base]);

  const rec: CheckpointRecord = { id, sha, label, createdAt: new Date().toISOString() };
  await appendRecord(workDir, rec);
  return rec;
}

export async function rollbackCheckpoint(
  workDir: string,
  id: string,
): Promise<{ ok: boolean; message: string }> {
  if (!(await isGitRepo(workDir))) {
    return { ok: false, message: "不是 git 仓库，无法回滚" };
  }
  const recs = await listCheckpoints(workDir);
  const hit = resolveCheckpointTarget(recs, id);
  if (!hit) {
    return { ok: false, message: `检查点不存在：${id}` };
  }
  const { target, matchedBy } = hit;

  await snapshot(workDir, "safety before rollback");

  await git(workDir, ["reset", "--hard", target.sha]);
  // untracked 文件不受 reset --hard 影响；现场已被 safety 快照收录，clean 使工作区精确对齐目标点
  // -e .tupigcode：运行时数据（检查点索引/消息快照）必须在任何仓都幸存
  await git(workDir, ["clean", "-fd", "-e", ".tupigcode"]);
  const by = matchedBy === "label" ? "，按名称匹配" : "";
  return { ok: true, message: `已回滚到检查点 ${target.id}（${target.label}${by}）` };
}

// ---------- issue #14：自动快照 + /rewind 三档 ----------

/** 消息快照文件路径（/rewind chat/all 档回卷用） */
function msgSnapPath(workDir: string, id: string): string {
  return join(workDir, ".tupigcode", "msg-snap", `${id}.json`);
}

/** git 快照 + 同时保存对话消息副本（供 rewind 档位回卷） */
export async function snapshotWithMessages(
  workDir: string,
  label: string,
  messages: unknown[],
): Promise<CheckpointRecord | null> {
  const rec = await snapshot(workDir, label);
  if (!rec) return null;
  if (messages.length > 0) {
    await mkdir(join(workDir, ".tupigcode", "msg-snap"), { recursive: true });
    await writeFile(msgSnapPath(workDir, rec.id), JSON.stringify(messages), "utf-8");
  }
  return rec;
}

// 防抖：同一 workDir 在窗口期内只建一个自动快照
const lastAutoAt = new Map<string, number>();
const AUTO_DEBOUNCE_MS = 5_000;

/** 自动快照（工具写后/每轮后调用）：无改动、非 git、防抖窗口内 → null 静默 */
export async function autoSnapshot(
  workDir: string,
  label: string,
  messages: unknown[] = [],
  debounceMs = AUTO_DEBOUNCE_MS,
): Promise<CheckpointRecord | null> {
  const now = Date.now();
  const last = lastAutoAt.get(workDir) ?? 0;
  if (now - last < debounceMs) return null;
  // 占位前移（issue #92）：await 前锁定窗口，并发调用不再建双快照（避免 git index.lock 冲突）
  lastAutoAt.set(workDir, now);
  return snapshotWithMessages(workDir, label, messages);
}

export type RewindMode = "chat" | "code" | "all";

export type RewindResult = {
  ok: boolean;
  message: string;
  /** chat/all 档：回卷到的消息（无消息快照时 undefined） */
  messages?: unknown[];
};

/** 三档回卷：chat=只回对话 / code=只回代码 / all=两者都回 */
export async function rewind(
  workDir: string,
  id: string,
  mode: RewindMode,
): Promise<RewindResult> {
  const recs = await listCheckpoints(workDir);
  const hit = resolveCheckpointTarget(recs, id);
  if (!hit) return { ok: false, message: `检查点不存在：${id}` };
  const target = hit.target;

  const parts: string[] = [];
  let messages: unknown[] | undefined;

  if (mode === "chat" || mode === "all") {
    try {
      messages = JSON.parse(await readFile(msgSnapPath(workDir, target.id), "utf-8")) as unknown[];
      parts.push(`对话回卷 ${Array.isArray(messages) ? messages.length : 0} 条`);
    } catch {
      parts.push("无消息快照");
    }
  }

  if (mode === "code" || mode === "all") {
    const rb = await rollbackCheckpoint(workDir, target.id);
    if (!rb.ok) return { ok: false, message: rb.message };
    parts.push("代码已恢复");
  }

  const label: Record<RewindMode, string> = { chat: "仅对话", code: "仅代码", all: "对话+代码" };
  return { ok: true, message: `已回滚（${label[mode]}）到 ${id}：${parts.join("、")}`, messages };
}

/** 滚动清理：只保留最新 keep 条（jsonl + git ref + 消息文件同步删除） */
export async function pruneCheckpoints(workDir: string, keep: number): Promise<number> {
  const recs = await listCheckpoints(workDir); // 倒序：新→旧
  if (recs.length <= keep) return 0;
  const kept = recs.slice(0, keep);
  const removed = recs.slice(keep);

  const lines = [...kept].reverse().map((r) => JSON.stringify(r)).join("\n") + "\n";
  await mkdir(join(workDir, ".tupigcode"), { recursive: true });
  await writeFileAtomic(jsonlPath(workDir), lines);

  for (const r of removed) {
    try {
      await git(workDir, ["update-ref", "-d", CKPT_REF_PREFIX + r.id]);
    } catch { /* ref 可能已不存在 */ }
    try {
      await rm(msgSnapPath(workDir, r.id), { force: true });
    } catch { /* 忽略 */ }
  }
  return removed.length;
}
