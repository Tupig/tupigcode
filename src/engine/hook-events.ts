/**
 * engine/hookEvents.ts — 生命周期事件触发（issue #26）
 *
 * Stop / SessionStart / PreCompact / PostCompact 此前只有类型声明没有
 * 触发点；统一出口：吞掉一切异常（hook 失败不阻塞主流程），
 * 压缩事件透传 source（manual/auto）供 matcher 过滤。
 */
import {
  hookSystem, type HookSystem, type HookContext, type HookEvent, type HookResult, type NotificationType,
} from "./hooks.js";

export async function fireLifecycle(
  hs: HookSystem,
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  try {
    await hs.trigger(event, ctx);
  } catch {
    /* hook 失败不阻塞 */
  }
}

export async function fireSessionStart(hs: HookSystem = hookSystem, ctx: HookContext): Promise<void> {
  await fireLifecycle(hs, "SessionStart", ctx);
}

export async function fireStop(hs: HookSystem = hookSystem, ctx: HookContext): Promise<void> {
  await fireLifecycle(hs, "Stop", ctx);
}

/** 压缩前（供需要在 Pre/Post 之间夹压缩动作的调用方） */
export async function fireCompactPre(
  hs: HookSystem = hookSystem,
  ctx: HookContext,
  source: "manual" | "auto" | "model",
): Promise<void> {
  await fireLifecycle(hs, "PreCompact", { ...ctx, source });
}

/** 压缩后 */
export async function fireCompactPost(
  hs: HookSystem = hookSystem,
  ctx: HookContext,
  source: "manual" | "auto" | "model",
): Promise<void> {
  await fireLifecycle(hs, "PostCompact", { ...ctx, source });
}

/** 便捷：连发 Pre+Post（无夹心动作时用） */
export async function fireCompact(
  hs: HookSystem = hookSystem,
  ctx: HookContext,
  source: "manual" | "auto" | "model",
): Promise<void> {
  await fireCompactPre(hs, ctx, source);
  await fireCompactPost(hs, ctx, source);
}

/** /clear 序列（issue #33）：Pre → 清空 → Post；hook 异常吞掉，reset 异常上抛 */
export async function runClearSequence(
  hs: HookSystem,
  ctx: HookContext,
  reset: () => void,
): Promise<void> {
  await fireLifecycle(hs, "PreClear", ctx);
  reset();
  await fireLifecycle(hs, "PostClear", ctx);
}

/** /rewind 回滚成功后（issue #34）：失败不触发 */
export async function fireRewindPost(
  hs: HookSystem,
  result: { ok: boolean },
  meta: { checkpointId: string; mode: string },
  ctx: HookContext,
): Promise<void> {
  if (!result.ok) return;
  await fireLifecycle(hs, "PostRewind", { ...ctx, input: { ...meta } });
}

/** 权限落定（issue #35）：allow/deny/always 决策后触发供审计 */
export async function firePermissionResult(
  hs: HookSystem,
  meta: {
    toolName: string;
    decision: "allow" | "deny" | "always";
    ruleSource?: string;
    durationMs?: number;
  },
  ctx: HookContext,
): Promise<void> {
  await fireLifecycle(hs, "PermissionResult", {
    ...ctx,
    toolName: meta.toolName,
    decision: meta.decision,
    ruleSource: meta.ruleSource,
    durationMs: meta.durationMs,
  });
}

/** 工具执行失败/超时（issue #36）：仅执行阶段错误触发 */
export async function firePostToolUseFailure(
  hs: HookSystem,
  meta: {
    toolName: string;
    input?: Record<string, unknown>;
    output: string;
    durationMs?: number;
  },
  ctx: HookContext,
): Promise<void> {
  await fireLifecycle(hs, "PostToolUseFailure", {
    ...ctx,
    toolName: meta.toolName,
    input: meta.input,
    output: meta.output,
    durationMs: meta.durationMs,
  });
}

/** 模式切换（issue #42）：from=to 视作未切换不触发 */
export async function fireModeChange(
  hs: HookSystem,
  from: string,
  to: string,
  ctx: HookContext,
): Promise<void> {
  if (from === to) return;
  await fireLifecycle(hs, "ModeChange", { ...ctx, modeFrom: from, modeTo: to });
}

/**
 * UserPromptSubmit（issue #48）：prompt 进模型前触发。
 * 返回 HookResult 供入口消费（block=拒绝本轮、additionalContext=注入上下文）；
 * 与其他 fire* 不同需要透出结果，异常吞成空结果（hook 失败不阻塞）。
 */
export async function fireUserPromptSubmit(
  hs: HookSystem = hookSystem,
  ctx: HookContext,
): Promise<HookResult> {
  try {
    return await hs.trigger("UserPromptSubmit", ctx);
  } catch {
    return {};
  }
}

/** Notification（issue #52）：权限询问 / REPL 空闲两类「等待用户」通知，matcher 按类型过滤 */
export async function fireNotification(
  hs: HookSystem = hookSystem,
  type: NotificationType,
  ctx: HookContext,
): Promise<void> {
  await fireLifecycle(hs, "Notification", { ...ctx, notificationType: type });
}
