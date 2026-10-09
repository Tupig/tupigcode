/**
 * E67 B 批深度审查（#48-#52）
 *
 * 审查点 1（#50/#52）：hashRule 必须覆盖 matcher 全字段——任一字段变更都应
 *   使 TOFU 信任失效重询，notificationType 是最后纳入的字段，防漏。
 * 审查点 2（#49）：block handler 未带 message 时，合并结果应回落到 block 前
 *   注册序第一个非空 message（拦截必须有可读文案，不能因 block 者缺 message 而变空）。
 * 审查点 3（#48）：additionalContext 注入必须是 prompt **之后**的独立 user 消息
 *   （顺序颠倒会让模型把注入上下文当用户原话）。
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { HookSystem, type ShellHookConfig } from "../../src/engine/hooks.js";
import { hashRule } from "../../src/engine/hook-trust.js";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0"; // 跳过 shell hook TOFU 首询
});

afterEach(() => {
  delete process.env.TUPIG_HOOKS_FILE;
});

describe("审查点 1：hashRule 覆盖 matcher 全字段（含 notificationType）", () => {
  const base: ShellHookConfig = {
    event: "Notification",
    matcher: { notificationType: "permission_prompt" },
    command: "echo hi",
    timeout: 1000,
  };

  it("notificationType 变更 → hash 不同（TOFU 重询）", () => {
    const other: ShellHookConfig = {
      ...base,
      matcher: { notificationType: "idle_prompt" },
    };
    expect(hashRule(base)).not.toBe(hashRule(other));
  });

  it("matcher 缺省 vs 显式空字段之外的任一字段变更都改 hash", () => {
    const withTool: ShellHookConfig = {
      event: "Notification",
      matcher: { tool_name: "Bash", source: "shell", decision: "allow", modeTo: "plan", notificationType: "idle_prompt" },
      command: "echo hi",
    };
    const noMatcher: ShellHookConfig = { event: "Notification", command: "echo hi" };
    expect(hashRule(withTool)).not.toBe(hashRule(noMatcher));
    for (const field of ["tool_name", "source", "decision", "modeTo", "notificationType"] as const) {
      const mutated: ShellHookConfig = {
        ...noMatcher,
        matcher: { ...withTool.matcher!, [field]: field === "modeTo" ? "code" : field === "decision" ? "deny" : field === "notificationType" ? "permission_prompt" : "Grep" },
      };
      expect(hashRule(mutated)).not.toBe(hashRule(withTool));
    }
  });
});

describe("审查点 2：block 无 message 时回落 block 前的 message（#49 合并边界）", () => {
  it("前面 handler 的 message 不因 block 者缺 message 而丢", async () => {
    const hs = new HookSystem();
    hs.register({
      event: "PreToolUse",
      handler: async () => ({ message: "前置提示" }),
    });
    hs.register({
      event: "PreToolUse",
      handler: async () => ({ block: true }), // block 但不带 message
    });
    hs.register({
      event: "PreToolUse",
      handler: async () => ({ message: "后续提示" }), // block 之后的 message 不生效
    });
    const out = await hs.trigger("PreToolUse", { turnNumber: 1, sessionId: "s" });
    expect(out.block).toBe(true);
    expect(out.message).toBe("前置提示");
  });

  it("block 带 message 则用 block 者自己的", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PreToolUse", handler: async () => ({ message: "前置" }) });
    hs.register({ event: "PreToolUse", handler: async () => ({ block: true, message: "拦截理由" }) });
    const out = await hs.trigger("PreToolUse", { turnNumber: 1, sessionId: "s" });
    expect(out.block).toBe(true);
    expect(out.message).toBe("拦截理由");
  });
});

describe("审查点 3：additionalContext 注入顺序（#48）", () => {
  it("注入消息紧跟 prompt 之后，且带标记标签", async () => {
    const { QueryEngine } = await import("../../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e67-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(
      join(dir, ".tupigcode", "hooks.json"),
      JSON.stringify([
        { event: "UserPromptSubmit", command: "echo '{\"additionalContext\":\"E67-CTX\"}'" },
      ]),
    );
    process.env.TUPIG_HOOKS_FILE = join(dir, ".tupigcode", "hooks.json");

    const { hookSystem } = await import("../../src/engine/hooks.js");
    hookSystem.clear();
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 512, maxTurns: 1, routeProvider: "mock",
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;
    let captured: any = null;
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: (params: any) => {
            captured = params;
            return (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
              yield { type: "message_stop" };
            })();
          },
        },
      },
    };

    const chunks: any[] = [];
    for await (const m of engine.submitMessage("原始问题")) chunks.push(m);
    expect(captured).toBeTruthy();

    const msgs: any[] = captured.messages;
    const promptIdx = msgs.findIndex((m) => textOf(m).includes("原始问题"));
    const ctxIdx = msgs.findIndex((m) => textOf(m).includes("E67-CTX"));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(promptIdx); // 注入在 prompt 之后
    expect(String(textOf(msgs[ctxIdx]))).toContain("<user-prompt-submit-hook additionalContext>");
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

const textOf = (m: any): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((b: any) => b?.text ?? "").join("")
      : "";
