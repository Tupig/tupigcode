/**
 * E46 并行批 fail-soft + 去全局流式锁（#43）
 *
 * - mapWithConcurrency 改 settled 语义：单任务异常不整批 reject
 * - QueryEngine 批次闸门：同批只读工具并发执行，互不阻塞
 * - 批内异常各自吃 error tool_result，兄弟任务结果保留
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mapWithConcurrency } from "../../src/tools/parallel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("mapWithConcurrency fail-soft（settled 语义）", () => {
  it("单任务异常不整批 reject，兄弟结果保留且顺序不变", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 3, async (x) => {
      await sleep(10);
      if (x === 2) throw new Error("boom");
      return x * 10;
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(out[1].status).toBe("rejected");
    expect((out[1] as { status: string; reason: unknown }).reason).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ status: "fulfilled", value: 30 });
  });

  it("全部任务失败也 resolve（不 reject）", async () => {
    const out = await mapWithConcurrency([1, 2], 2, async () => {
      throw new Error("all-bad");
    });
    expect(out.every((r) => r.status === "rejected")).toBe(true);
  });
});

type BatchItem = { buf: { id: string; name: string; inputJson: string }; input: Record<string, unknown> | null };

async function makeEngine() {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const dir = mkdtempSync(join(tmpdir(), "tupig-a1-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  const engine = new QueryEngine({
    cwd: dir,
    model: "mock",
    maxTokens: 1024,
    maxTurns: 3,
    routeProvider: "mock",
  });
  return engine;
}

function globItem(id: string, pattern: string): BatchItem {
  const input = { pattern };
  return { buf: { id, name: "Glob", inputJson: JSON.stringify(input) }, input };
}

describe("批次闸门：同批只读工具并发执行", () => {
  it("两个 Glob 并发均成功，不出现「另一个工具正在执行中」", async () => {
    const engine: any = await makeEngine();
    const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
    const events: any[] = [];
    const loopState = { messages: [], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
    const batch = [globItem("t1", "*.ts"), globItem("t2", "**/*.ts")];

    await engine.runBatch(batch, engine.buildToolContext(), engine.buildCanUseToolFn(), loopState, events, toolResults);

    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((r) => r.content).join("\n")).not.toContain("另一个工具正在执行中");
    for (const r of toolResults) expect(r.is_error).toBeFalsy();
  }, 15_000);

  it("批内一个工具异常 → 自己吃 error tool_result，兄弟结果保留", async () => {
    const engine: any = await makeEngine();
    const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
    const events: any[] = [];
    const loopState = { messages: [], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
    const batch = [globItem("t1", "*.ts"), globItem("t2", "**/*.ts")];
    const okCanUse = engine.buildCanUseToolFn();
    const canUse = async (toolName: string, input: Record<string, unknown>) => {
      if ((input as { pattern?: string }).pattern === "*.ts") throw new Error("权限层爆炸");
      return okCanUse(toolName, input);
    };

    await engine.runBatch(batch, engine.buildToolContext(), canUse, loopState, events, toolResults);

    const failed = toolResults.find((r) => r.tool_use_id === "t1");
    const ok = toolResults.find((r) => r.tool_use_id === "t2");
    expect(failed?.is_error).toBe(true);
    expect(failed?.content).toContain("权限层爆炸");
    expect(ok?.is_error).toBeFalsy();
  }, 15_000);
});
