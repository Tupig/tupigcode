/**
 * E60 写工具按 file_path 分组并行（issue #57）
 *
 * - partitionWriteGroups：同文件保序一组、异文件各自成组、无 file_path 独立
 * - resolveWriteConcurrency：TUPIG_WRITE_CONCURRENCY 覆盖、非法回退默认
 * - QueryEngine 集成：A/B/A 三写 → A 组串行（后写覆盖）、A/B 组间并行（峰值并发≥2）、全部成功
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { partitionWriteGroups, mapWithConcurrency } from "../../src/tools/parallel";
import { resolveWriteConcurrency, MAX_WRITE_CONCURRENCY } from "../../src/engine/constants";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => { process.env.TUPIG_MOCK = "1"; });
afterAll(() => { delete process.env.TUPIG_WRITE_CONCURRENCY; });

describe("partitionWriteGroups", () => {
  it("同文件保序成组、异文件成组", () => {
    const items = [
      { id: 1, file: "a.ts" },
      { id: 2, file: "b.ts" },
      { id: 3, file: "a.ts" },
      { id: 4, file: "c.ts" },
    ];
    const groups = partitionWriteGroups(items, (i) => i.file);
    expect(groups).toHaveLength(3);
    expect(groups[0].map((i) => i.id)).toEqual([1, 3]); // a.ts 保序
    expect(groups[1].map((i) => i.id)).toEqual([2]);
    expect(groups[2].map((i) => i.id)).toEqual([4]);
  });

  it("无 file_path（null）→ 各自独立组", () => {
    const groups = partitionWriteGroups(
      [{ id: 1, file: null }, { id: 2, file: "a.ts" }, { id: 3, file: null }],
      (i) => i.file,
    );
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(1);
    expect(groups[2]).toHaveLength(1);
  });

  it("组间并行（mapWithConcurrency 包组）fail-soft", async () => {
    const groups = [[1], [2], [3]];
    const settled = await mapWithConcurrency(groups, 4, async (g) => {
      if (g[0] === 2) throw new Error("组炸");
      return g[0];
    });
    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    expect(settled[2].status).toBe("fulfilled");
  });
});

describe("resolveWriteConcurrency", () => {
  it("默认 MAX_WRITE_CONCURRENCY", () => {
    delete process.env.TUPIG_WRITE_CONCURRENCY;
    expect(resolveWriteConcurrency()).toBe(MAX_WRITE_CONCURRENCY);
  });
  it("合法覆盖 / 非法回退", () => {
    process.env.TUPIG_WRITE_CONCURRENCY = "8";
    expect(resolveWriteConcurrency()).toBe(8);
    process.env.TUPIG_WRITE_CONCURRENCY = "abc";
    expect(resolveWriteConcurrency()).toBe(MAX_WRITE_CONCURRENCY);
    delete process.env.TUPIG_WRITE_CONCURRENCY;
  });
});

async function makeEngine() {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const dir = mkdtempSync(join(tmpdir(), "tupig-e60-"));
  mkdirSync(join(dir, ".tupigcode"), { recursive: true });
  const engine: any = new QueryEngine({
    cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  engine.client = {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            for (const t of tools) {
              yield { type: "content_block_start", content_block: { type: "tool_use", id: t.id, name: t.name } };
              yield {
                type: "content_block_delta",
                delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) },
              };
              yield { type: "content_block_stop" };
            }
            yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
  return { engine, dir, tools };
}

const loopState = () => ({
  messages: [] as any[], turnCount: 1, compacted: false,
  maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false,
});

describe("QueryEngine 写分组集成", () => {
  it("A/B/A 三写：A 组串行后写覆盖，A 与 B 并行，全部成功", async () => {
    const { engine, dir, tools } = await makeEngine();
    tools.push(
      { id: "t1", name: "Write", input: { file_path: join(dir, "a.ts"), content: "A-first\n" } },
      { id: "t2", name: "Write", input: { file_path: join(dir, "b.ts"), content: "B-content\n" } },
      { id: "t3", name: "Write", input: { file_path: join(dir, "a.ts"), content: "A-second\n" } },
    );

    // 包装 Write.call 记录并发峰值与同文件重叠
    const writeTool = engine.tools.find((t: any) => t.name === "Write");
    const origCall = writeTool.call.bind(writeTool);
    let active = 0, maxActive = 0;
    const intervals: Array<{ file: string; t0: number; t1: number }> = [];
    writeTool.call = async (...args: any[]) => {
      const file = String(args[0]?.file_path ?? "?");
      const t0 = Date.now();
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      try {
        return await origCall(...args);
      } finally {
        active--;
        intervals.push({ file, t0, t1: Date.now() });
      }
    };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), async () => ({ behavior: "allow" }));

    expect(res.toolResults).toHaveLength(3);
    expect(res.toolResults.every((r: any) => !r.is_error)).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("A-second\n"); // 同文件保序，后写生效
    expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("B-content\n");
    expect(maxActive).toBeGreaterThanOrEqual(2); // A 组与 B 组并行
    // A 组内两次写不重叠（串行链）
    const aWrites = intervals.filter((i) => i.file.endsWith("a.ts")).sort((x, y) => x.t0 - y.t0);
    expect(aWrites).toHaveLength(2);
    expect(aWrites[0].t1).toBeLessThanOrEqual(aWrites[1].t0);
  }, 20_000);
});
