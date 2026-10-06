/**
 * E90 工具执行健壮性三连（issue #99）
 *
 * - withTimeout：超时即 abort controller，文案带副作用提示
 * - 工具返回 isError → tool_result is_error:true + PostToolUseFailure，PostToolUse 不触发
 * - 流报错 return 前 await 早期派发：后台结果落进 events（不脱钩）
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

describe("withTimeout 超时取消底层", () => {
  it("超时 → controller.abort 已触发 + 文案带副作用提示", async () => {
    const { withTimeout } = await import("../src/engine/time");
    const ac = new AbortController();
    await expect(
      withTimeout(new Promise(() => {}), 30, "工具 Write", {
        controller: ac,
        sideEffectHint: "写类操作可能已部分落盘，请核对文件状态",
      }),
    ).rejects.toThrow(/写类操作可能已部分落盘/);
    expect(ac.signal.aborted).toBe(true);
  });

  it("无 controller/无 hint → 默认副作用提示", async () => {
    const { withTimeout } = await import("../src/engine/time");
    await expect(withTimeout(new Promise(() => {}), 30, "工具 Bash")).rejects.toThrow(
      /底层操作可能仍在执行/,
    );
  });

  it("正常完成不 abort", async () => {
    const { withTimeout } = await import("../src/engine/time");
    const ac = new AbortController();
    await expect(withTimeout(Promise.resolve("ok"), 1000, "t", { controller: ac })).resolves.toBe("ok");
    expect(ac.signal.aborted).toBe(false);
  });
});

describe("工具结果错误语义（isToolResultError → is_error + Failure hook）", () => {
  it("isError / output.type=error → true；正常 → false", async () => {
    const { isToolResultError } = await import("../src/engine/Tool");
    expect(isToolResultError({ isError: true })).toBe(true);
    expect(isToolResultError({ output: { type: "error", error: "e" } })).toBe(true);
    expect(isToolResultError({})).toBe(false);
    expect(isToolResultError({ isError: false, output: { type: "text", text: "ok" } })).toBe(false);
  });

  it("executeTurn：工具返回 isError → is_error、PostToolUseFailure、不 fire PostToolUse、不快照", async () => {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const { hookSystem } = await import("../src/engine/hooks");
    const cwd = mkdtempSync(join(tmpdir(), "tupig-e90-"));
    const engine: any = new QueryEngine({
      cwd, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;

    const failures: any[] = [];
    const successes: any[] = [];
    hookSystem.register({ event: "PostToolUseFailure", handler: (c) => { failures.push(c); } });
    hookSystem.register({ event: "PostToolUse", handler: (c) => { successes.push(c); } });
    try {
      const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [
        { id: "tu_err", name: "Glob", input: { pattern: "**/*.ts" } },
      ];
      engine.client = {
        type: "anthropic",
        anthropic: {
          messages: {
            stream: () =>
              (async function* () {
                yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
                for (const t of tools) {
                  yield { type: "content_block_start", content_block: { type: "tool_use", id: t.id, name: t.name } };
                  yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } };
                  yield { type: "content_block_stop" };
                }
                yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } };
                yield { type: "message_stop" };
              })(),
          },
        },
      };
      // Glob 返回工具级错误（不 throw）
      const glob = engine.tools.find((t: any) => t.name === "Glob");
      glob.call = async () => ({ data: "错误：未找到匹配文件", isError: true });

      const ls = {
        messages: [] as any[], turnCount: 1, compacted: false,
        maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
      };
      const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

      expect(res.toolResults).toHaveLength(1);
      expect(res.toolResults[0].is_error).toBe(true);
      const tr = res.events.find((e: any) => e.type === "tool_result");
      expect(tr.isError).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0].toolName).toBe("Glob");
      expect(successes).toHaveLength(0);
    } finally {
      hookSystem.clear();
    }
  }, 15_000);
});

describe("流报错 return 前 await 早期派发", () => {
  it("早期派发工具结果落进 events 与 toolResults（不脱钩）", async () => {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const cwd = mkdtempSync(join(tmpdir(), "tupig-e90b-"));
    const engine: any = new QueryEngine({
      cwd, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;

    const glob = engine.tools.find((t: any) => t.name === "Glob");
    glob.call = async () => {
      await new Promise((r) => setTimeout(r, 80)); // 慢早期派发，报错先到
      return { data: "found.ts" };
    };
    // 流派发 Glob 后立刻抛非 infra 错误（401），不切兜底
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_start", content_block: { type: "tool_use", id: "tu_early", name: "Glob" } };
              yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"pattern":"**/*.ts"}' } };
              yield { type: "content_block_stop" };
              throw new Error("401 unauthorized");
            })(),
        },
      },
    };

    const ls = {
      messages: [] as any[], turnCount: 1, compacted: false,
      maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
    };
    const res = await engine.executeTurn(ls, engine.buildToolContext(), async () => ({ behavior: "allow" as const }));

    expect(res.stopReason).toBe("error");
    // 早期派发结果已 await 落地：events 与 toolResults 都含该 tool_use_id
    expect(res.toolResults.some((r: any) => r.tool_use_id === "tu_early")).toBe(true);
    expect(res.events.some((e: any) => e.type === "tool_result" && e.toolUseId === "tu_early")).toBe(true);
  }, 15_000);
});
