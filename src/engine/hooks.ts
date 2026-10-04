/**
 * hooks/system.ts — Hook 系统
 */
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { HOOK_TIMEOUT_MS } from "./constants.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "PreClear"
  | "PostClear"
  | "PostRewind"
  | "PermissionResult"
  | "Notification"
  | "ModeChange"
  | "Stop"
  | "SessionStart"
  | "SessionEnd";

export type HookType = "shell" | "llm-evaluated" | "webhook";

export interface HookContext {
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  turnNumber: number;
  sessionId: string;
  /** 压缩事件触发方：manual | auto（issue #26） */
  source?: string;
  /** 工具执行纯耗时 ms（不含权限询问与 PreToolUse，issue #31） */
  durationMs?: number;
  /** 权限最终决策（issue #35） */
  decision?: "allow" | "deny" | "always";
  /** 决策来源：规则/持久 allow/交互/敏感 deny 等描述 */
  ruleSource?: string;
  /** 模式切换前后（issue #42） */
  modeFrom?: string;
  modeTo?: string;
  /** Notification 事件类型（issue #52） */
  notificationType?: "permission_prompt" | "idle_prompt";
}

export type NotificationType = "permission_prompt" | "idle_prompt";
const NOTIFICATION_TYPES = new Set<string>(["permission_prompt", "idle_prompt"]);

export type HookResult = {
  block?: boolean;
  replacement?: string;
  message?: string;
  /** UserPromptSubmit 注入的附加上下文（issue #48），多 hook 合并时拼接 */
  additionalContext?: string;
};

export type HookHandler = (
  ctx: HookContext,
) => Promise<HookResult | void> | HookResult | void;

export function interpretShellExit(
  code: number | null,
  stdout: string,
  stderr: string,
  failOpen = false,
): HookResult {
  const enforce = !failOpen && process.env.TUPIG_HOOKS_FAIL_OPEN !== "1";

  if (code === 0) {
    try {
      const parsed = JSON.parse(stdout);
      const ac = parsed?.hookSpecificOutput?.additionalContext ?? parsed?.additionalContext;
      return {
        block: parsed.block === true,
        replacement: parsed.replacement,
        message: parsed.message,
        additionalContext: typeof ac === "string" && ac.length > 0 ? ac : undefined,
      };
    } catch {
      return {};
    }
  }
  if (code === 2) {
    return { block: true, message: (stderr || stdout || "hook exit 2").trim() };
  }
  if (code === null) {
    return { block: enforce, message: "hook 超时（fail-closed）" };
  }
  return { block: enforce, message: `hook 退出码 ${code}（fail-closed）${stderr ? "：" + stderr.trim() : ""}` };
}

export type ShellHookConfig = {
  event: HookEvent;
  matcher?: {
    tool_name?: string;
    source?: string;
    decision?: "allow" | "deny" | "always";
    modeTo?: string;
    notificationType?: NotificationType;
  };
  command: string;
  timeout?: number;
};

const DECISIONS = new Set(["allow", "deny", "always"]);

export function loadShellHooks(workDir: string): ShellHookConfig[] {
  const file = process.env.TUPIG_HOOKS_FILE || join(workDir, ".tupigcode", "hooks.json");
  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((h: any) => typeof h?.command === "string" && typeof h?.event === "string")
      .map((h: any) => ({
        event: h.event as HookEvent,
        matcher: h.matcher && typeof h.matcher === "object"
          ? {
              ...(typeof h.matcher.tool_name === "string" ? { tool_name: h.matcher.tool_name } : {}),
              ...(typeof h.matcher.source === "string" ? { source: h.matcher.source } : {}),
              // decision/modeTo 此前被丢弃（issue #50）
              ...(typeof h.matcher.decision === "string" && DECISIONS.has(h.matcher.decision)
                ? { decision: h.matcher.decision as "allow" | "deny" | "always" }
                : {}),
              ...(typeof h.matcher.modeTo === "string" ? { modeTo: h.matcher.modeTo } : {}),
              ...(typeof h.matcher.notificationType === "string" && NOTIFICATION_TYPES.has(h.matcher.notificationType)
                ? { notificationType: h.matcher.notificationType as NotificationType }
                : {}),
            }
          : undefined,
        command: h.command,
        timeout: typeof h.timeout === "number" ? h.timeout : undefined,
      }));
  } catch {
    return [];
  }
}

export type HookMatcher = {
  event: HookEvent;
  matcher?: {
    tool_name?: string;
    source?: string;
    decision?: "allow" | "deny" | "always";
    modeTo?: string;
    notificationType?: NotificationType;
  };
  handler: HookHandler;
  type?: HookType;
  timeout?: number;
};

/**
 * tool_name 匹配（issue #50）：全串锚定正则 `^(?:pattern)$`——
 * `Edit|Write` 命中两工具且不误伤 MultiEdit；既有精确配置行为不变；
 * 子串意图写 `.*X.*`；非法正则回退精确比较。
 */
export function matchToolPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return pattern === value;
  }
}

export class HookSystem {
  private matchers: HookMatcher[] = [];
  /** shell hooks.json 注册快照（issue #51 热加载只换这一批） */
  private shellMatchers: HookMatcher[] = [];

  register(matcher: HookMatcher): void {
    this.matchers.push(matcher);
  }

  /** 注册 shell 来源 hook（可被 reloadShell 整批替换） */
  registerShell(matcher: HookMatcher): void {
    this.matchers.push(matcher);
    this.shellMatchers.push(matcher);
  }

  /** 整批替换 shell 注册；代码注册（register）不受影响。返回新注册数 */
  reloadShell(matchers: HookMatcher[]): number {
    const shellSet = new Set(this.shellMatchers);
    this.matchers = this.matchers.filter((m) => !shellSet.has(m));
    this.shellMatchers = [];
    for (const m of matchers) this.registerShell(m);
    return matchers.length;
  }

  /** 当前 shell hook 注册数 */
  shellCount(): number {
    return this.shellMatchers.length;
  }

  /** 清空全部匹配器（测试隔离 / 热重载） */
  clear(): void {
    this.matchers = [];
    this.shellMatchers = [];
  }

  async trigger(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const matching = this.matchers.filter((m) => {
      if (m.event !== event) return false;
      if (m.matcher?.tool_name && (ctx.toolName === undefined || !matchToolPattern(m.matcher.tool_name, ctx.toolName))) return false;
      if (m.matcher?.source && m.matcher.source !== ctx.source) return false;
      if (m.matcher?.decision && m.matcher.decision !== ctx.decision) return false;
      if (m.matcher?.modeTo && m.matcher.modeTo !== ctx.modeTo) return false;
      if (m.matcher?.notificationType && m.matcher.notificationType !== ctx.notificationType) return false;
      return true;
    });

    // 并行执行（issue #49）：不串行叠加超时；单点异常隔离，不影响其他 hook
    const results = await Promise.all(
      matching.map(async (m) => {
        try {
          return await m.handler(ctx);
        } catch (err) {
          if (process.env.TUPIG_DEBUG) {
            console.error(`[Hook] 处理器执行出错：`, err);
          }
          return null;
        }
      }),
    );

    // 最严合并（issue #49）：block 优先且不被后续覆盖；未 block 取注册序
    // 第一个非空 message/replacement；additionalContext 拼接不互相覆盖
    let blockFirst: HookResult | null = null;
    let message: string | undefined;
    let replacement: string | undefined;
    const acParts: string[] = [];
    for (const r of results) {
      if (!r) continue;
      if (typeof r.additionalContext === "string" && r.additionalContext.length > 0) acParts.push(r.additionalContext);
      if (r.block) {
        if (!blockFirst) blockFirst = r;
        continue;
      }
      if (blockFirst) continue; // block 之后的 handler 结果视为不生效（等价原短路）
      if (r.message && message === undefined) message = r.message;
      if (r.replacement && replacement === undefined) replacement = r.replacement;
    }

    const out: HookResult = {};
    if (blockFirst) {
      out.block = true;
      out.message = blockFirst.message ?? message;
      if (blockFirst.replacement) out.replacement = blockFirst.replacement;
    } else {
      if (message !== undefined) out.message = message;
      if (replacement !== undefined) out.replacement = replacement;
    }
    if (acParts.length > 0) out.additionalContext = acParts.join("\n");
    return out;
  }

  async triggerShellHook(
    command: string,
    ctx: HookContext,
    timeoutMs = HOOK_TIMEOUT_MS,
  ): Promise<HookResult> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn("bash", ["-c", command], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      // 子进程可能不读 stdin 就退出（快退 hook/CI 竞态），忽略 EPIPE 防未捕获异常
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(ctx));
      child.stdin.end();

      const finish = (result: HookResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish(interpretShellExit(null, stdout, stderr));
      }, timeoutMs);

      child.on("close", (code) => {
        finish(interpretShellExit(code, stdout, stderr));
      });

      child.on("error", () => finish(interpretShellExit(127, stdout, stderr)));
    });
  }
}

export const hookSystem = new HookSystem();

// ---- shell hooks 热加载（issue #51）----

export type ShellHookFactory = () => HookMatcher[];

let shellFactory: ShellHookFactory | null = null;
let shellWorkDir = "";
let shellMtimeMs = Number.NaN; // NaN = 未初始化

export function hooksFilePath(workDir: string): string {
  return process.env.TUPIG_HOOKS_FILE || join(workDir, ".tupigcode", "hooks.json");
}

function statHooksMtime(workDir: string): number {
  try {
    return statSync(hooksFilePath(workDir)).mtimeMs;
  } catch {
    return -1; // 文件不存在
  }
}

/**
 * 构造时一次性初始化：记录工厂与 mtime 并完成首批注册。
 * 工厂由调用方提供（需携带 cwd、TOFU 信任闭包），reload 时复用。
 */
export function initShellHooks(workDir: string, factory: ShellHookFactory): number {
  shellFactory = factory;
  shellWorkDir = workDir;
  shellMtimeMs = statHooksMtime(workDir);
  return hookSystem.reloadShell(factory());
}

/** 入口惰性检查：mtime 变了才重载，没变零动作。返回是否重载 */
export function reloadShellHooksIfChanged(): boolean {
  if (!shellFactory) return false;
  const m = statHooksMtime(shellWorkDir);
  if (m === shellMtimeMs) return false;
  shellMtimeMs = m;
  hookSystem.reloadShell(shellFactory());
  return true;
}

/** 强制重载（/hooks reload），不看 mtime。返回新注册数；未初始化返回 -1 */
export function reloadShellHooks(): number {
  if (!shellFactory) return -1;
  shellMtimeMs = statHooksMtime(shellWorkDir);
  return hookSystem.reloadShell(shellFactory());
}
