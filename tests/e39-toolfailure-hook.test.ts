/**
 * E39 PostToolUseFailure 补触发（issue #36）
 * 执行错误/超时触发一次（带 error output + durationMs）/ 异常隔离 / 字段正确
 */
import { describe, it, expect, afterEach, vi } from "vitest";
// 环境必须在静态 import（模块求值）前生效——constants.ts 的 TOOL_TIMEOUT_MS
// 是 import 期求值的（issue #84 接线后 hooks 也静态触达 constants）
const CLEAN_ENV = vi.hoisted(() => {
  const clean = { ...process.env };
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_TOOL_TIMEOUT_MS = "300";
  return clean;
});
import { HookSystem, type HookContext } from "../src/engine/hooks";
import { firePostToolUseFailure } from "../src/engine/hookEvents";

function base(): HookContext {
  return { turnNumber: 3, sessionId: "s-fail" };
}

describe("PostToolUseFailure 单元", () => {
  it("带 output（错误消息）+ durationMs 触发一次", async () => {
    const hs = new HookSystem();
    const seen: HookContext[] = [];
    hs.register({ event: "PostToolUseFailure", handler: (c) => { seen.push(c); } });
    await firePostToolUseFailure(
      hs, { toolName: "Bash", input: { command: "sleep 9" }, output: "工具 Bash 执行超时（300ms）", durationMs: 305 }, base(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].output).toContain("超时");
    expect(seen[0].durationMs).toBe(305);
    expect(seen[0].toolName).toBe("Bash");
  });

  it("触发器抛异常 → 静默隔离", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PostToolUseFailure", handler: () => { throw new Error("boom"); } });
    await expect(
      firePostToolUseFailure(hs, { toolName: "Grep", output: "x", durationMs: 1 }, base()),
    ).resolves.toBeUndefined();
  });
});

describe("PostToolUseFailure 端到端：工具超时触发", () => {
  afterEach(() => {
    process.env = { ...CLEAN_ENV };
  });

  it("mock + bypassPermissions + 超时 → 触发带超时 output（20s 限时）", async () => {
    const { query } = await import("../src/engine/QueryEngine");
    const { hookSystem } = await import("../src/engine/hooks");
    const seen: HookContext[] = [];
    hookSystem.register({ event: "PostToolUseFailure", handler: (c) => { seen.push(c); } });
    try {
      let result: any = null;
      const iter = query({
        prompt: "运行 sleep 9",
        options: {
          cwd: process.cwd(), model: "mock",
          permissionMode: "bypassPermissions",
        },
      });
      for await (const msg of iter as any) {
        if (msg.type === "result") result = msg;
      }
      expect(result?.subtype).toBeTruthy();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0].output).toContain("超时");
      expect(typeof seen[0].durationMs).toBe("number");
      expect(seen[0].durationMs!).toBeGreaterThanOrEqual(250);
    } finally {
      hookSystem.clear();
    }
  }, 30_000);
});
