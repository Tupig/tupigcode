/**
 * E51 UserPromptSubmit hook（issue #48）
 *
 * - interpretShellExit 解析 additionalContext（平铺 JSON 与 Claude Code
 *   hookSpecificOutput 嵌套两种形态）
 * - prompt 进模型前触发 UserPromptSubmit；block → 拒绝本轮、不发起模型请求
 * - 多 hook 的 additionalContext 合并注入到本轮消息（prompt 之后）
 * - 无 hook 时行为不变
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { interpretShellExit, hookSystem, type HookResult } from "../../src/engine/hooks";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

/** 消息 content 可能是 string 或 blocks（末条经 cache 断点转换，fix #63） */
const textOf = (m: any): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((b: any) => b?.text ?? "").join("")
      : "";

beforeEach(() => { hookSystem.clear(); });
afterEach(() => { hookSystem.clear(); });

async function makeEngine(capture?: (params: any) => void) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const dir = mkdtempSync(join(tmpdir(), "tupig-e51-"));
  const engine: any = new QueryEngine({
    cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  engine.client = {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: (params: any) => {
          capture?.(params);
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })();
        },
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

describe("interpretShellExit 解析 additionalContext", () => {
  it("平铺 JSON additionalContext", () => {
    const r = interpretShellExit(0, JSON.stringify({ additionalContext: "CTX-FLAT" }), "");
    expect(r.additionalContext).toBe("CTX-FLAT");
    expect(r.block).toBeFalsy();
  });

  it("hookSpecificOutput.additionalContext（Claude Code 形态）", () => {
    const r = interpretShellExit(
      0,
      JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX-NESTED" } }),
      "",
    );
    expect(r.additionalContext).toBe("CTX-NESTED");
  });

  it("exit 2 → block 且无 additionalContext", () => {
    const r = interpretShellExit(2, "", "拒绝：危险输入");
    expect(r.block).toBe(true);
    expect(r.message).toContain("拒绝");
    expect(r.additionalContext).toBeUndefined();
  });
});

describe("submitMessage 触发 UserPromptSubmit", () => {
  it("block → 拒绝本轮，输出拦截原因，不发起模型请求", async () => {
    let modelCalled = false;
    const { engine } = await makeEngine(() => { modelCalled = true; });
    hookSystem.register({
      event: "UserPromptSubmit",
      handler: (ctx) => ({ block: true, message: `拦截：${JSON.stringify((ctx.input as any)?.prompt)}` }),
    });

    const out = await collect(engine.submitMessage("危险指令"));

    expect(modelCalled).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect(out[0].text).toContain("拦截");
    expect(out[0].text).toContain("危险指令");
  }, 15_000);

  it("两个 hook 的 additionalContext 合并注入，prompt 正常进模型", async () => {
    let captured: any = null;
    const { engine } = await makeEngine((p) => { captured = p; });
    hookSystem.register({ event: "UserPromptSubmit", handler: () => ({ additionalContext: "CTX-A" }) });
    hookSystem.register({ event: "UserPromptSubmit", handler: () => ({ additionalContext: "CTX-B" }) });

    const out = await collect(engine.submitMessage("你好 tupig"));

    expect(captured).toBeTruthy();
    const msgs: any[] = captured.messages;
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => textOf(m).includes("你好 tupig"))).toBe(true);
    const injected = userMsgs.find((m) => textOf(m).includes("CTX-A"));
    expect(injected).toBeTruthy();
    expect(textOf(injected)).toContain("CTX-B");
    expect(out.some((m) => m.type === "result")).toBe(true);
  }, 15_000);

  it("无 hook → 正常发起，无注入标记", async () => {
    let captured: any = null;
    const { engine } = await makeEngine((p) => { captured = p; });

    const out = await collect(engine.submitMessage("普通提问"));

    expect(captured).toBeTruthy();
    const msgs: any[] = captured.messages;
    expect(msgs.some((m) => m.role === "user" && textOf(m).includes("普通提问"))).toBe(true);
    expect(msgs.every((m) => !textOf(m).includes("additionalContext"))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  }, 15_000);

  it("block+message 缺省时给出默认拦截文案", async () => {
    const { engine } = await makeEngine();
    hookSystem.register({ event: "UserPromptSubmit", handler: (): HookResult => ({ block: true }) });

    const out = await collect(engine.submitMessage("hi"));

    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("UserPromptSubmit");
  }, 15_000);
});
