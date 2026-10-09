/**
 * services/approvalStore.ts — 审批「总是允许」持久化（issue #28）
 *
 * 审批 prompt 选 a → 推导模式写入 .tupigcode/permissions.json（项目级）；
 * canUseTool 在规则链之后查持久 allow。敏感路径 deny、自修改面 ask、
 * deny 规则仍优先（在 permissions.ts 中的检查顺序保证）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export const APPROVAL_FILE = ".tupigcode/permissions.json";

export interface AlwaysAllowEntry {
  pattern: string;
  source: string;
  addedAt: string;
}

export function approvalPath(workDir: string): string {
  return join(workDir, APPROVAL_FILE);
}

export function loadAlwaysAllow(workDir: string): AlwaysAllowEntry[] {
  try {
    const p = approvalPath(workDir);
    if (!existsSync(p)) return [];
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (!Array.isArray(data?.alwaysAllow)) return [];
    return data.alwaysAllow.filter(
      (e: any) => typeof e?.pattern === "string" && typeof e?.source === "string",
    );
  } catch {
    return []; // 损坏回退：当作无规则
  }
}

export function saveAlwaysAllow(workDir: string, entries: AlwaysAllowEntry[]): void {
  try {
    const p = approvalPath(workDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ alwaysAllow: entries }, null, 2), "utf-8");
  } catch {
    /* 写失败不影响本轮（下次仍会询问） */
  }
}

/** 追加一条（去重） */
export function addAlwaysAllow(workDir: string, pattern: string): void {
  const list = loadAlwaysAllow(workDir);
  if (list.some((e) => e.pattern === pattern)) return;
  list.push({ pattern, source: "user:always", addedAt: new Date().toISOString() });
  saveAlwaysAllow(workDir, list);
}

/** 清除全部，返回清除条数 */
export function clearAlwaysAllow(workDir: string): number {
  const n = loadAlwaysAllow(workDir).length;
  saveAlwaysAllow(workDir, []);
  return n;
}

/**
 * 由「总是允许」的选择推导模式：
 * - Bash 多词 → 首词前缀通配 `Bash(npm *)`；单词 → `Bash`
 * - 写工具/其他 → 工具级（敏感路径与自修改面由 canUseTool 兜底）
 */
export function deriveAlwaysPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const words = String(input.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "Bash";
    if (words.length === 1) return "Bash";
    return `Bash(${words[0]} *)`;
  }
  return toolName;
}

/** 查询持久 allow 是否命中（matchesRule 语义由调用方复用或独立实现） */
export function evaluatePersistentAllow(
  workDir: string,
  toolName: string,
  input: Record<string, unknown>,
  matcher?: (pattern: string) => boolean,
): boolean {
  const list = loadAlwaysAllow(workDir);
  if (list.length === 0) return false;
  for (const e of list) {
    if (matcher) {
      if (matcher(e.pattern)) return true;
    } else if (patternMatches(e.pattern, toolName, input)) {
      return true;
    }
  }
  return false;
}

/** 与 permissions.ts matchesRule 同语义的独立实现（避免循环依赖） */
function patternMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = pattern.match(/^(\w+)(?:\((.+)\))?$/);
  if (!m) return toolName === pattern;
  const [, name, argPattern] = m;
  if (name !== toolName) return false;
  if (!argPattern) return true;
  const escaped = argPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  try {
    const re = new RegExp("^" + escaped + "$");
    const candidates = [
      String(input.command ?? ""),
      String((input as any).file_path ?? (input as any).path ?? (input as any).notebook_path ?? ""),
      JSON.stringify(input),
    ].filter(Boolean);
    return candidates.some((c) => re.test(c));
  } catch {
    return false;
  }
}
