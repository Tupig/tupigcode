/**
 * E3 端到端：mock 带工具链路限时完成 + 非 TTY 快速拒绝
 */
import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("mock 端到端不卡死", () => {
  it("带工具调用两轮内完成（20s 限时）", async () => {
    const { query } = await import("../../src/engine/QueryEngine");
    let result: any = null;
    let rounds = 0;
    const iter = query({ prompt: "读 src/index.ts", options: { cwd: process.cwd(), model: "mock" } });
    for await (const msg of iter as any) {
      if (msg.type === "result") result = msg;
      if (msg.type === "tool_use") rounds++;
    }
    expect(result).toBeTruthy();
    expect(result.subtype).toBe("success");
    expect(rounds).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

describe("非 TTY 权限确认快速拒绝", () => {
  it("stdin 非 TTY 时立即返回 false（不等 30s）", async () => {
    const { promptUser } = await import("../../src/services/permissions");
    const t0 = Date.now();
    const ok = await promptUser("Write", { file_path: "x.ts", content: "x" });
    const elapsed = Date.now() - t0;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);
});
