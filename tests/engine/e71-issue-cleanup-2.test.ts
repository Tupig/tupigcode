/**
 * E71 issue 清理批次 2（#69 / #70）
 *
 * 审查点 1（#69）：turnNumber 必须是会话内真实输入序号——
 *   UserPromptSubmit 为该条输入的 0-based 序号（hook 侧可直接观测到 0,1,…，
 *   block 的输入也占号）；permission_prompt 为弹问时已提交输入数。
 * 审查点 2（#70）：#49 并行合并的两处收紧定性为有意行为并锁定——
 *   a) block 者未带 replacement → 不保留前面 handler 的 replacement
 *   b) block 之后 handler 的 additionalContext 仍被收集（消费方自行丢弃）
 */
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { HookSystem } from "../../src/engine/hooks";
import { appStore } from "../../src/state/AppState";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

beforeEach(() => {
  appStore.setState((s) => ({ ...s, userPromptCount: 0 }));
});

/** 会记录 turnNumber 的 UserPromptSubmit shell hook（ctx 经 stdin JSON 传入） */
function turnLoggerHook(logFile: string): unknown {
  const js =
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").appendFileSync(process.argv[1],String(JSON.parse(d).turnNumber)+"\\n")})';
  return {
    event: "UserPromptSubmit",
    command: `node -e '${js}' ${logFile}`,
  };
}

async function makeEngine(hookJson: unknown[]) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const { hookSystem } = await import("../../src/engine/hooks");
  hookSystem.clear();
  const dir = mkdtempSync(join(tmpdir(), "tupig-e71-"));
  mkdirSync(join(dir, ".tupigcode"), { recursive: true });
  writeFileSync(join(dir, ".tupigcode", "hooks.json"), JSON.stringify(hookJson));
  process.env.TUPIG_HOOKS_FILE = join(dir, ".tupigcode", "hooks.json");
  const engine: any = new QueryEngine({
    cwd: dir, model: "mock", maxTokens: 512, maxTurns: 1, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  engine.client = {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
  return { engine, dir };
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("审查点 1：turnNumber 为真实输入序号（#69）", () => {
  it("hook 收到依次 0、1（0-based，与 appStore 同源）", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "tupig-e71log-")), "turns.log");
    const { engine, dir } = await makeEngine([turnLoggerHook(logFile)]);
    try {
      await collect(engine.submitMessage("第一条"));
      await collect(engine.submitMessage("第二条"));
      const lines = readFileSync(logFile, "utf8").trim().split("\n");
      expect(lines).toEqual(["0", "1"]);
      expect(appStore.getState().userPromptCount).toBe(2);
    } finally {
      delete process.env.TUPIG_HOOKS_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("block 拒绝的输入也占号（输入已发生）", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "tupig-e71log2-")), "turns.log");
    const { engine, dir } = await makeEngine([
      turnLoggerHook(logFile),
      { event: "UserPromptSubmit", command: "exit 2" }, // 第二个 hook 拒绝
    ]);
    try {
      const out1 = await collect(engine.submitMessage("被拒的"));
      // block 生效：输出 hook 拒绝文案，未进模型（无 "ok" 回复）
      expect(out1.some((m) => m.type === "text" && String(m.text).includes("exit 2"))).toBe(true);
      expect(out1).toHaveLength(1); // 仅拦截文案，未发起模型流
      expect(appStore.getState().userPromptCount).toBe(1);
      const lines = readFileSync(logFile, "utf8").trim().split("\n");
      expect(lines).toEqual(["0"]); // 占号后被 block，序号已消费
    } finally {
      delete process.env.TUPIG_HOOKS_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("permission_prompt 的 turnNumber = 弹问时已提交输入数", async () => {
    appStore.setState((s) => ({ ...s, userPromptCount: 3 }));
    const { hookSystem } = await import("../../src/engine/hooks");
    const { promptUserDecision } = await import("../../src/services/permissions");
    hookSystem.clear();
    const seen: number[] = [];
    hookSystem.register({
      event: "Notification",
      matcher: { notificationType: "permission_prompt" },
      handler: async (c) => {
        seen.push(c.turnNumber);
        return {};
      },
    });
    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const p = promptUserDecision("Bash", { command: "x" });
      await new Promise((r) => setTimeout(r, 30)); // void fire 落地
      process.stdin.emit("data", "y\n");
      await p;
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as any).isTTY;
      hookSystem.clear();
    }
    expect(seen).toEqual([3]);
  });
});

describe("审查点 2：#49 并行合并两处收紧锁定（#70）", () => {
  it("a) block 者未带 replacement → 丢弃前面 handler 的 replacement", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PreToolUse", handler: async () => ({ replacement: '{"cmd":"hacked"}' }) });
    hs.register({ event: "PreToolUse", handler: async () => ({ block: true, message: "拒绝" }) });
    const out = await hs.trigger("PreToolUse", { turnNumber: 1, sessionId: "s" });
    expect(out.block).toBe(true);
    expect(out.replacement).toBeUndefined(); // 收紧：不保留
  });

  it("b) block 之后 handler 的 additionalContext 仍被收集", async () => {
    const hs = new HookSystem();
    hs.register({ event: "UserPromptSubmit", handler: async () => ({ block: true, message: "拦" }) });
    hs.register({ event: "UserPromptSubmit", handler: async () => ({ additionalContext: "AFTER-BLOCK-CTX" }) });
    const out = await hs.trigger("UserPromptSubmit", { turnNumber: 1, sessionId: "s" });
    expect(out.block).toBe(true);
    expect(out.additionalContext).toBe("AFTER-BLOCK-CTX"); // 收集；block 消费方整体丢弃
  });
});
