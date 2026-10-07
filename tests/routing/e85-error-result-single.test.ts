/**
 * E85 错误/中断路径只产出 error result（issue #95）
 *
 * - API 错误 → 只产出一条 error result，不追加「任务已完成」success result
 * - route.log feedback 记 success:false（不污染 A23 画像）
 * - abort 中断 → error result，不进成功分支
 * - 对照：正常结束仍是一条 success result + feedback success:true
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});

async function makeEngine(dir?: string) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const cwd = dir ?? mkdtempSync(join(tmpdir(), "tupig-e85-"));
  const engine: any = new QueryEngine({
    cwd, model: "mock", maxTokens: 1024, maxTurns: 3, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  return { engine, cwd };
}

/** 业务错误（非 infra，不触发 failover）→ executeTurn 返回 stopReason=error */
function failClient(msg = "401 unauthorized") {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
            throw new Error(msg);
          })(),
      },
    },
  };
}

function okClient() {
  return {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

function lastFeedback(cwd: string): any | null {
  const p = join(cwd, ".tupigcode", "route.log");
  if (!existsSync(p)) return null;
  const rows = readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => r.type === "feedback").at(-1) ?? null;
}

describe("API 错误路径只产出一条 error result", () => {
  it("不追加 success result、feedback 记失败", async () => {
    const { engine, cwd } = await makeEngine();
    engine.client = failClient();

    const out = await collect(engine.submitMessage("你好"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");

    const fb = lastFeedback(cwd);
    expect(fb).toBeTruthy();
    expect(fb.success).toBe(false);
  }, 15_000);

  it("对照：正常结束仍是一条 success + feedback success:true", async () => {
    const { engine, cwd } = await makeEngine();
    engine.client = okClient();

    const out = await collect(engine.submitMessage("你好"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("success");

    const fb = lastFeedback(cwd);
    expect(fb).toBeTruthy();
    expect(fb.success).toBe(true);
  }, 15_000);
});

describe("abort 中断不进成功分支", () => {
  it("interrupt 后 submitMessage → error result（任务已中断）", async () => {
    const { engine, cwd } = await makeEngine();
    engine.client = okClient();
    engine.interrupt();

    const out = await collect(engine.submitMessage("你好"));

    const results = out.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");
    expect(results[0].result).toContain("中断");

    const fb = lastFeedback(cwd);
    expect(fb).toBeTruthy();
    expect(fb.success).toBe(false);
  }, 15_000);
});
