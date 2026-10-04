/**
 * services/permissions.ts — 权限系统
 */
import type { Tool, PermissionResult } from "../engine/Tool.js";
import type { ToolPermissionContext } from "../state/AppState.js";
import { classifyBash } from "./bashSafety.js";
import { getMcpApproval } from "../engine/mcp.js";
import { resolve } from "path";
import { appStore } from "../state/AppState.js";
import { withPromptLock } from "./promptLock.js";
import { planRerouteTarget, ensureStagedSeed } from "../engine/staging.js";
import chalk from "chalk";
import { evaluatePersistentAllow, deriveAlwaysPattern, addAlwaysAllow } from "./approvalStore.js";
import { fireNotification } from "../engine/hookEvents.js";
import { readFile } from "fs/promises";
import { resolve as resolvePath } from "path";
import { previewEdit } from "../tools/FileEdit.js";
import { renderOpsPreview } from "../engine/diffReview.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesRule(toolName: string, input: Record<string, unknown>, pattern: string): boolean {
  const match = pattern.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return toolName === pattern;

  const [, patternName, argPattern] = match;
  if (toolName !== patternName) return false;

  if (argPattern) {
    const escaped = escapeRegExp(argPattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    try {
      const re = new RegExp("^" + escaped + "$");
      // 候选值：命令串 / 文件路径 / 完整 JSON（任一命中即匹配，issue #28）
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
  return true;
}

function evaluateRules(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolPermissionContext,
): "allow" | "deny" | "ask" | null {
  for (const [, rules] of ctx.alwaysDenyRules) {
    for (const rule of rules) {
      if (matchesRule(toolName, input, rule.pattern)) return "deny";
    }
  }
  for (const [, rules] of ctx.alwaysAskRules) {
    for (const rule of rules) {
      if (matchesRule(toolName, input, rule.pattern)) return "ask";
    }
  }
  for (const [, rules] of ctx.alwaysAllowRules) {
    for (const rule of rules) {
      if (matchesRule(toolName, input, rule.pattern)) return "allow";
    }
  }
  return null;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** 系统敏感路径（写入一律 deny）；边界含 `.`、`/` 前导，认相对穿越（issue #87） */
const SENSITIVE_PATH = /(^|[\s'"=/.])(\/etc(\/|$)|\/usr\/|\/bin\/|\/sbin\/|\/System\/|\/Library\/|\/private\/|\/dev\/(sd|disk|nvme)|\/\.ssh(\/|$))/;

/** 远程/发布类命令：即使 mutate 也恒 ask（issue #13） */
const REMOTE_PUBLISH = /\bgit\s+push\b|\bpublish\b|\brelease\b|\bdeploy\b/;

/** 内容是否触及系统敏感路径（命令串或文件路径） */
export function touchesSensitivePath(s: string): boolean {
  return SENSITIVE_PATH.test(s);
}

/** 命中自身护栏文件（skills/mcp/hooks/config）的写操作 → 强制复审（issue #12） */
export function isSelfModifyWrite(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    return (
      cmd.includes(".tupigcode/skills") ||
      cmd.includes(".tupigcode/mcp.json") ||
      cmd.includes(".tupigcode/config.json") ||
      (!!process.env.TUPIG_HOOKS_FILE && cmd.includes(process.env.TUPIG_HOOKS_FILE))
    );
  }
  if (!WRITE_TOOLS.has(toolName)) return false;

  const raw = String((input as any).file_path ?? (input as any).path ?? (input as any).notebook_path ?? "");
  if (!raw) return false;
  const p = resolve(raw);
  if (p.includes("/.tupigcode/skills/")) return true;
  if (p.endsWith("/.tupigcode/mcp.json")) return true;
  if (p.endsWith("/.tupigcode/config.json")) return true;
  if (process.env.TUPIG_HOOKS_FILE && p === resolve(process.env.TUPIG_HOOKS_FILE)) return true;
  return false;
}

export async function canUseTool(
  toolName: string,
  input: Record<string, unknown>,
  tool: Tool | undefined,
  ctx: ToolPermissionContext,
): Promise<PermissionResult> {
  const { mode } = ctx;

  if (mode === "bypassPermissions") {
    return { behavior: "allow", decisionReason: "bypassPermissions 模式" };
  }

  if (mode === "plan") {
    if (tool?.isReadOnly(input)) {
      return { behavior: "allow", decisionReason: "plan 模式：只读工具" };
    }
    // 可写面①：spec/plan 产物（阶段②落盘），路径逃逸在 resolve 后失效
    // 基线用 workDir 而非 cwd（issue #92：-w 后两者分裂，cwd 基线会误判仓外路径）
    const workDir = appStore.getState().workDir;
    const artifact = String((input as any).file_path ?? (input as any).path ?? "");
    if (artifact && (toolName === "Write" || toolName === "Edit") && resolve(workDir, artifact).includes("/.tupigcode/specs/")) {
      return { behavior: "allow", decisionReason: "plan 模式：计划产物可写" };
    }
    // 可写面②：工作区内改动暂存 staging（issue #18），/apply 指令才落盘
    if (artifact && (toolName === "Write" || toolName === "Edit")) {
      const staged = planRerouteTarget(workDir, artifact);
      if (staged) {
        await ensureStagedSeed(resolve(workDir, artifact), staged);
        return {
          behavior: "allow",
          decisionReason: "plan 模式：改动暂存 staging（/apply 落盘）",
          updatedInput: { ...input, file_path: staged },
        };
      }
    }
    return { behavior: "deny", message: "plan 模式下不允许写操作", decisionReason: "plan 模式" };
  }

  // 敏感路径写 deny 前移（issue #28）：任何 allow 规则（含持久 always）都不得绕过
  // 相对路径先 resolve（workDir 基线，issue #87），防穿越漏检
  if (WRITE_TOOLS.has(toolName)) {
    const rawP = String((input as any).file_path ?? (input as any).path ?? (input as any).notebook_path ?? "");
    if (rawP && touchesSensitivePath(resolve(appStore.getState().workDir, rawP))) {
      return { behavior: "deny", message: `目标为系统敏感路径，已拒绝：${rawP}` };
    }
  }
  // Bash 写类命令同样前移（issue #87）：allow 规则不得旁路敏感命令检测；只读命令不拦截
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (cmd && classifyBash(cmd) !== "safe" && touchesSensitivePath(cmd)) {
      return { behavior: "deny", message: `命令触及系统敏感路径，已拒绝：${cmd.slice(0, 200)}` };
    }
  }

  const ruleResult = evaluateRules(toolName, input, ctx);
  if (ruleResult === "deny") {
    return { behavior: "deny", message: `工具「${toolName}」已被规则禁止`, decisionReason: "deny 规则" };
  }
  // 自修改面（issue #12）：写自身护栏强制复审，绕过 alwaysAllow；deny/ask 规则仍在其前后生效
  if (isSelfModifyWrite(toolName, input)) {
    return { behavior: "ask", message: `自修改面（护栏/技能/配置文件）需要确认：${toolName}` };
  }
  if (ruleResult === "ask") {
    return { behavior: "ask", message: `工具「${toolName}」需要审批` };
  }
  if (ruleResult === "allow") {
    return { behavior: "allow", decisionReason: "allow 规则" };
  }
  // 项目级持久「总是允许」（issue #28）：与 allow 规则同强度，位于 deny/ask/自修改面之后
  if (evaluatePersistentAllow(appStore.getState().workDir, toolName, input)) {
    return { behavior: "allow", decisionReason: "持久总是允许（permissions.json）" };
  }

  // MCP 双重审批（issue #10）：通用规则（deny/ask/allow）已判，plan/bypass 已前置拦截
  const mcpDecision = getMcpApproval(toolName);
  if (mcpDecision !== undefined) {
    const env = process.env.TUPIG_MCP_APPROVAL;
    if (env === "off") {
      return { behavior: "allow", decisionReason: "TUPIG_MCP_APPROVAL=off" };
    }
    if (env === "ask") {
      return { behavior: "ask", message: `MCP 工具「${toolName}」需要用户确认（TUPIG_MCP_APPROVAL=ask）` };
    }
    if (mcpDecision === "deny") {
      return { behavior: "deny", message: `MCP 工具「${toolName}」已被 mcp.json 审批禁止`, decisionReason: "mcp deny" };
    }
    if (mcpDecision === "ask") {
      return { behavior: "ask", message: `MCP 工具「${toolName}」需要用户确认（mcp.json 审批）` };
    }
    if (mcpDecision === "allow") {
      return { behavior: "allow", decisionReason: "mcp.json 白名单" };
    }
    // "default"：未配置审批 → 落回通用链（readOnlyHint 分级）
  }

  if (mode === "acceptEdits") {
    if (tool?.isReadOnly(input)) {
      return { behavior: "allow", decisionReason: "acceptEdits：只读" };
    }
    if (tool && !tool.isDestructive?.(input) && toolName !== "Bash") {
      return { behavior: "allow", decisionReason: "acceptEdits：非破坏性写入" };
    }
  }

  if (mode === "dontAsk") {
    return { behavior: "deny", message: "dontAsk 模式：工具未被预先批准", decisionReason: "dontAsk 模式" };
  }

  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    const safety = classifyBash(cmd);
    if (safety === "destructive") {
      return { behavior: "ask", message: `危险命令（destructive）：${cmd.slice(0, 200)}` };
    }
    if (safety === "mutate") {
      // 风险分类器（issue #13）：敏感路径已在上方前移 deny（issue #87），此处只剩远程发布 ask
      if (REMOTE_PUBLISH.test(cmd)) {
        return { behavior: "ask", message: `远程/发布类命令需确认：${cmd.slice(0, 200)}` };
      }
      return { behavior: "allow", decisionReason: "风险分类器：mutate 命令自动放行" };
    }
    // safe → 落到下方只读放行
  }

  if (tool?.isReadOnly(input)) {
    return { behavior: "allow", decisionReason: "默认：只读/安全命令" };
  }

  return { behavior: "ask", message: `工具「${toolName}」需要用户确认` };
}

export type ApprovalDecision = "allow" | "deny" | "always";

async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

/**
 * 审批 diff 预览（issue #54/#72）：Edit/Write/MultiEdit 渲染真实变更（含新建/覆盖）；
 * 其他工具、定位失败、内容无变化 → null（调用方回退 JSON 截断）。
 */
export async function buildApprovalPreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  try {
    const fp = String(input.file_path ?? "");
    if (!fp) return null;
    const path = resolvePath(appStore.getState().workDir, fp);

    if (toolName === "Edit") {
      const before = await readIfExists(path);
      if (before === null) return null;
      const after = previewEdit(before, {
        old_string: String(input.old_string ?? ""),
        new_string: String(input.new_string ?? ""),
        replace_all: input.replace_all === true,
      });
      if (after === null || after === before) return null;
      return renderOpsPreview([{ path, before, after }]);
    }
    if (toolName === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      if (edits.length === 0) return null;
      const before = await readIfExists(path);
      if (before === null) return null;
      let after: string | null = before;
      for (const e of edits) {
        after = previewEdit(after, {
          old_string: String(e.old_string ?? ""),
          new_string: String(e.new_string ?? ""),
          replace_all: e.replace_all === true,
        });
        if (after === null) return null; // 任一处不匹配 → 回退 JSON
      }
      if (after === before) return null;
      return renderOpsPreview([{ path, before, after }]);
    }
    if (toolName === "Write") {
      const after = String(input.content ?? "");
      const before = await readIfExists(path);
      if (before === after) return null;
      return renderOpsPreview([{ path, before, after }]);
    }
    return null;
  } catch {
    return null;
  }
}

function printPreview(preview: string): void {
  for (const line of preview.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      console.log(chalk.cyan(line));
    } else if (line.startsWith("+")) {
      console.log(chalk.green(line));
    } else if (line.startsWith("-")) {
      console.log(chalk.red(line));
    } else {
      console.log(chalk.gray(line));
    }
  }
}

/**
 * 三态审批（issue #28）：y=本次放行 / a=总是允许（推导模式写入
 * .tupigcode/permissions.json）/ 其他或超时=拒绝。
 */
export async function promptUserDecision(
  toolName: string,
  input: Record<string, unknown>,
  opts?: { allowAlways?: boolean },
): Promise<ApprovalDecision> {
  if (!process.stdin.isTTY) return "deny";
  // 串行化（issue #64）：同一时刻只弹一个问，后续并发调用按序排队
  return withPromptLock(() => promptUserDecisionLocked(toolName, input, opts));
}

/** 审批应答解析（issue #92）：粘贴多行取首行判定，y⏎后杂散内容不再误拒 */
export function parseApprovalAnswer(data: string): string {
  return data.split("\n", 1)[0].trim().toLowerCase();
}

async function promptUserDecisionLocked(
  toolName: string,
  input: Record<string, unknown>,
  opts?: { allowAlways?: boolean },
): Promise<ApprovalDecision> {
  // Notification（issue #52）：权限询问通知，fire-and-forget 不拖住弹问
  void fireNotification(undefined, "permission_prompt", {
    turnNumber: appStore.getState().userPromptCount, // 已提交输入数（issue #69）
    sessionId: appStore.getState().sessionId,
    toolName,
    input,
  });
  const allowAlways = opts?.allowAlways !== false;
  const inputStr = JSON.stringify(input, null, 2);
  const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "\n..." : inputStr;

  console.log(chalk.yellow(`\n需要审批：${toolName}`));
  // 审批 diff 预览（issue #54）：写工具渲染真实变更，其余回退 JSON 截断
  const preview = await buildApprovalPreview(toolName, input);
  if (preview) printPreview(preview);
  else console.log(chalk.gray(truncated));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.stdin.pause();
      resolve(result);
    };

    process.stdout.write(chalk.cyan(allowAlways ? "允许执行？(y/N/a=总是允许) " : "允许执行？(y/N) "));
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();

    process.stdin.once("data", (data: string) => {
      const answer = parseApprovalAnswer(data);
      if (answer === "y" || answer === "yes") return finish("allow");
      if (allowAlways && (answer === "a" || answer === "always")) {
        addAlwaysAllow(appStore.getState().workDir, deriveAlwaysPattern(toolName, input));
        return finish("always");
      }
      finish("deny");
    });

    process.stdin.once("close", () => finish("deny"));
    process.stdin.once("end", () => finish("deny"));

    // 30 秒超时
    const timeout = setTimeout(() => finish("deny"), 30_000);
  });
}

/** 兼容旧接口：总是允许视作放行（已在 promptUserDecision 内落盘） */
export async function promptUser(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const d = await promptUserDecision(toolName, input);
  return d !== "deny";
}
