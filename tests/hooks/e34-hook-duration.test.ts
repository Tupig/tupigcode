/**
 * E34 PostToolUse hook 附 duration_ms（issue #31）
 * 纯工具执行耗时（不含权限询问与 PreToolUse）；shell hook stdin payload 可见
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("PostToolUse 附 duration_ms", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("shell hook stdin payload 含 durationMs", async () => {
    const { HookSystem } = await import("../../src/engine/hooks");
    const dir = mkdtempSync(join(tmpdir(), "tupig-dur-"));
    const out = join(dir, "hook-stdin.json");
    try {
      const hs = new HookSystem();
      await hs.triggerShellHook(`python3 -c 'import sys; open(${JSON.stringify(out)}, "w").write(sys.stdin.read())'`, {
        toolName: "Read", input: { file_path: "README.md" }, output: "ok",
        turnNumber: 1, sessionId: "s-dur", durationMs: 123,
      }, 5000);
      const payload = JSON.parse(readFileSync(out, "utf8"));
      expect(payload.durationMs).toBe(123);
      expect(payload.toolName).toBe("Read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("端到端：PostToolUse 拿到数值 durationMs，PreToolUse 不含该字段", async () => {
    process.env.TUPIG_MOCK = "1";
    const { query } = await import("../../src/engine/QueryEngine");
    const { hookSystem } = await import("../../src/engine/hooks");
    const preCtx: any[] = [];
    const postCtx: any[] = [];
    hookSystem.register({ event: "PreToolUse", handler: (c) => { preCtx.push(c); } });
    hookSystem.register({ event: "PostToolUse", handler: (c) => { postCtx.push(c); } });
    try {
      let result: any = null;
      const iter = query({ prompt: "读 README.md", options: { cwd: process.cwd(), model: "mock" } });
      for await (const msg of iter as any) {
        if (msg.type === "result") result = msg;
      }
      expect(result?.subtype).toBe("success");
      expect(preCtx.length).toBeGreaterThanOrEqual(1);
      expect(postCtx.length).toBeGreaterThanOrEqual(1);
      // PreToolUse 不携带执行耗时（还没开始跑工具）
      expect(preCtx[0].durationMs).toBeUndefined();
      // PostToolUse 是数值、非负、且在合理量级内
      const dur = postCtx[0].durationMs;
      expect(typeof dur).toBe("number");
      expect(dur).toBeGreaterThanOrEqual(0);
      expect(dur).toBeLessThan(60_000);
    } finally {
      hookSystem.clear();
    }
  }, 20_000);
});
