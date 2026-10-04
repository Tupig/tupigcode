/**
 * engine/hookTrust.ts — hook 信任持久化 TOFU（issue #20，codex hook trust 思路）
 *
 * 首次触发询问用户，确认后写入「规则 hash → 信任」记录；
 * 规则变更（hash 不同）重新询问；拒绝不持久化（下次再问）；
 * 非 TTY / TUPIG_HOOK_TRUST=0 不打断（配置即显式意图）；
 * 异常/超时 fail-closed 逻辑不受信任影响。
 */
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import chalk from "chalk";
import type { ShellHookConfig } from "./hooks.js";
import { withPromptLock } from "../services/promptLock.js";
import { parseApprovalAnswer } from "../services/permissions.js";

export const TRUST_FILE = join(".tupigcode", "hook-trust.json");

type TrustStore = Record<string, { command: string; trustedAt: string }>;

function trustPath(workDir: string): string {
  return join(workDir, TRUST_FILE);
}

function loadTrust(workDir: string): TrustStore {
  try {
    const raw = JSON.parse(readFileSync(trustPath(workDir), "utf-8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveTrust(workDir: string, store: TrustStore): void {
  const file = trustPath(workDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
}

/** 规则 hash：event + matcher 全字段（tool_name/source/decision/modeTo）+ command + timeout 任一变更即失效重询 */
export function hashRule(h: ShellHookConfig): string {
  const payload = JSON.stringify([
    h.event,
    h.matcher?.tool_name ?? "",
    h.matcher?.source ?? "",
    h.matcher?.decision ?? "",
    h.matcher?.modeTo ?? "",
    h.matcher?.notificationType ?? "",
    h.command,
    h.timeout ?? 5000,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function isTrusted(workDir: string, h: ShellHookConfig): boolean {
  return !!loadTrust(workDir)[hashRule(h)];
}

/** 用户确认「允许」后落盘信任 */
export function recordTrusted(workDir: string, h: ShellHookConfig): void {
  const store = loadTrust(workDir);
  store[hashRule(h)] = { command: h.command, trustedAt: new Date().toISOString() };
  saveTrust(workDir, store);
}

/** 显式清除全部 hook 信任（/hooks clear） */
export function clearTrust(workDir: string): void {
  try {
    unlinkSync(trustPath(workDir));
  } catch { /* 不存在即已清空 */ }
}

export function listTrust(workDir: string): { hash: string; command: string; trustedAt: string }[] {
  const store = loadTrust(workDir);
  return Object.entries(store)
    .map(([hash, v]) => ({ hash, command: v.command, trustedAt: v.trustedAt }))
    .sort((a, b) => a.trustedAt.localeCompare(b.trustedAt));
}

/**
 * 信任闸门：run = 可直接执行（已信任/不可询问/显式关闭）；
 * ask = 待用户确认（调用方弹真实 TTY 询问后走 answerHookTrust）。
 */
export async function ensureHookTrust(
  workDir: string,
  h: ShellHookConfig,
  opts: { canPrompt?: boolean } = {},
): Promise<"run" | "ask"> {
  if (process.env.TUPIG_HOOK_TRUST === "0") return "run";
  if (isTrusted(workDir, h)) return "run";
  const canPrompt = opts.canPrompt ?? (Boolean(process.stdin.isTTY) && process.env.TUPIG_HOOK_TRUST !== "0");
  if (!canPrompt) return "run";
  return "ask";
}

/** 用户答复：yes → 记录信任并放行；no → 本次拒绝（不持久化，下次重询） */
export function answerHookTrust(workDir: string, h: ShellHookConfig, yes: boolean): "run" | "deny" {
  if (yes) {
    recordTrusted(workDir, h);
    return "run";
  }
  return "deny";
}

/** 真实 TTY 询问（仅 ensureHookTrust 返回 ask 时调用）；30s 超时按拒绝处理 */
export async function promptHookTrust(h: ShellHookConfig): Promise<boolean> {
  // 与审批弹问共用串行锁（issue #64）：同一时刻只占一个 readline
  return withPromptLock(() => new Promise((resolve) => {
    let settled = false;
    const onData = (d: string) => {
      const a = parseApprovalAnswer(d);
      finish(a === "y" || a === "yes");
    };
    const onClose = () => finish(false);
    const onEnd = () => finish(false);
    const finish = (r: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 显式移除三处监听（issue #101）：超时后不残留监听、不误吞后续 stdin 数据
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("close", onClose);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolve(r);
    };
    console.log(chalk.yellow("\nhook 首次触发，需要信任确认（TOFU，规则变更会重新询问）"));
    console.log(chalk.gray(`event: ${h.event}\ncommand: ${h.command}`));
    process.stdout.write(chalk.cyan("允许该 hook 持续执行？(y/N) "));
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("close", onClose);
    process.stdin.once("end", onEnd);
    const timer = setTimeout(() => finish(false), 30_000);
  }));
}
