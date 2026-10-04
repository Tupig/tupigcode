/**
 * session.ts — 会话持久化：save/load/list/fork（A5 resume/fork）
 */
import { mkdir, readFile, writeFile, readdir, stat } from "fs/promises";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { writeFileAtomic, writeFileAtomicSync } from "../utils/atomicWrite.js";

export type SessionMeta = {
  id: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
};

function sessionsDir(workDir: string): string {
  return join(workDir, ".tupigcode", "sessions");
}

/** sessionId 白名单（issue #90）：含 "/" 即路径穿越，拒绝一切读写 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export async function saveSessionMessages(
  workDir: string,
  sessionId: string,
  messages: unknown[],
  opts?: { interrupted?: boolean },
): Promise<void> {
  if (!isValidSessionId(sessionId)) return;
  await mkdir(sessionsDir(workDir), { recursive: true });
  await writeFileAtomic(
    join(sessionsDir(workDir), `${sessionId}.json`),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      messages,
      ...(opts?.interrupted ? { interrupted: true } : {}),
    }),
  );
}

/** SIGINT/SIGTERM 同步落盘（issue #27）：不等 Promise，直接同步写盘；空会话不写 */
export function rescueSessionSync(workDir: string, sessionId: string, messages: unknown[]): void {
  try {
    if (!messages || messages.length === 0) return;
    if (!isValidSessionId(sessionId)) return;
    const dir = sessionsDir(workDir);
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ updatedAt: new Date().toISOString(), messages, interrupted: true }),
    );
  } catch {
    /* 落盘失败也不能在信号处理里抛 */
  }
}

export type InterruptedSession = { id: string; messageCount: number; updatedAt: string };

/** 扫描带 interrupted 标记的孤儿会话（正常 turn 结束的保存不带标记，自然冲掉） */
export function listInterruptedSessions(workDir: string): InterruptedSession[] {
  try {
    const dir = sessionsDir(workDir);
    if (!existsSync(dir)) return [];
    const out: InterruptedSession[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (data?.interrupted === true && Array.isArray(data.messages)) {
          out.push({
            id: f.replace(/\.json$/, ""),
            messageCount: data.messages.length,
            updatedAt: String(data.updatedAt ?? ""),
          });
        }
      } catch {
        continue; // 损坏文件跳过
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

/** 手动清除 interrupted 标记（保留消息） */
export function clearInterruptedFlag(workDir: string, sessionId: string): void {
  try {
    if (!isValidSessionId(sessionId)) return;
    const p = join(sessionsDir(workDir), `${sessionId}.json`);
    if (!existsSync(p)) return;
    const data = JSON.parse(readFileSync(p, "utf-8"));
    delete data.interrupted;
    writeFileAtomicSync(p, JSON.stringify(data));
  } catch {
    /* 忽略 */
  }
}

/** 启动检测提示文案；无孤儿返回空串 */
export function formatInterruptedNotice(list: InterruptedSession[]): string {
  if (list.length === 0) return "";
  const lines = list.map((s) => `  - ${s.id}（${s.messageCount} 条，${s.updatedAt}）`);
  return `发现 ${list.length} 个未完成会话（Ctrl+C 打断）：\n${lines.join("\n")}\n恢复：/resume <id>`;
}

export async function loadSessionMessages<T = unknown>(
  workDir: string,
  sessionId: string,
): Promise<T[] | null> {
  if (!isValidSessionId(sessionId)) return null;
  try {
    const raw = await readFile(join(sessionsDir(workDir), `${sessionId}.json`), "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.messages)) return null;
    return data.messages as T[];
  } catch {
    return null;
  }
}

export async function listSessions(workDir: string): Promise<SessionMeta[]> {
  try {
    const files = await readdir(sessionsDir(workDir));
    const metas: SessionMeta[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const p = join(sessionsDir(workDir), f);
      try {
        const raw = await readFile(p, "utf-8");
        const data = JSON.parse(raw);
        const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
        // 首条用户 prompt（issue #32）：跳过 assistant 先发 / 空内容
        const firstUser = messages.find(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.length > 0,
        );
        const s = await stat(p);
        metas.push({
          id: f.replace(/\.json$/, ""),
          updatedAt: data.updatedAt ?? s.mtime.toISOString(),
          messageCount: messages.length,
          preview: truncatePreview(String(firstUser?.content ?? "")),
        });
      } catch {
        continue;
      }
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function forkMessages<T extends { role: string; content?: unknown }>(
  messages: T[],
  at: number,
): T[] {
  const cut = messages.slice(0, Math.max(0, Math.min(at, messages.length)));
  const last = cut[cut.length - 1];
  const danglingToolUse =
    last !== undefined &&
    last.role === "assistant" &&
    Array.isArray(last.content) &&
    (last.content as Array<{ type?: string }>).some((b) => b.type === "tool_use");
  if (danglingToolUse) cut.pop();
  return cut;
}

/** 预览截断（issue #32）：最多 60 字 */
export function truncatePreview(text: string, max = 60): string {
  // 折叠所有空白为单空格（issue #38：含换行的 prompt 会破列表行）
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "未知时间";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 会话列表行：id + 相对时间 + 条数 + 首条 prompt 预览（空则占位） */
export function formatSessionRow(s: SessionMeta): string {
  const preview = s.preview ? s.preview : "（无预览）";
  return `  ${s.id}  ${relativeTime(s.updatedAt)}  ${s.messageCount} 条  ${preview}`;
}
