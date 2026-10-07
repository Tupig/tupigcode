/**
 * F1/F2 压缩强化：阈值梯子+熔断+keep_first+结果预算（A13/A14）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ContextCompactor, pickStrategy, type Strategy } from "../../src/context/compact/index";
import type { ApiClient } from "../../src/services/api";
import type Anthropic from "@anthropic-ai/sdk";

describe("pickStrategy 阈值梯子（A13）", () => {
  it("<60% → 不压", () => {
    expect(pickStrategy(0.5, 10)).toBe("none");
    expect(pickStrategy(0.59, 10)).toBe("none");
  });
  it("60-70% → micro", () => {
    expect(pickStrategy(0.62, 10)).toBe("micro");
    expect(pickStrategy(0.69, 10)).toBe("micro");
  });
  it("70-85% → snip", () => {
    expect(pickStrategy(0.75, 10)).toBe("snip");
  });
  it("85-95% → collapse", () => {
    expect(pickStrategy(0.9, 10)).toBe("collapse");
  });
  it(">95% 或消息数超限 → force（模型摘要）", () => {
    expect(pickStrategy(0.96, 10)).toBe("force");
    expect(pickStrategy(0.5, 1000)).toBe("force");
  });
});

describe("阈值梯子分级压缩", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `msg-${i} ${"x".repeat(200)}`,
    }));

  it("低占用不压", () => {
    const c = new ContextCompactor();
    const msgs = mk(4);
    const r = c.compactByLadder(msgs, 1000, 30_000);
    expect(r.strategy).toBe("none");
    expect(r.messages).toBe(msgs);
  });
  it("中占用走 snip/micro 且不丢首条", () => {
    const c = new ContextCompactor();
    const msgs = mk(30);
    const r = c.compactByLadder(msgs, 24_000, 30_000);
    expect(["micro", "snip"]).toContain(r.strategy);
    expect(r.messages[0]).toBe(msgs[0]);
  });
  it("keep_first：压缩后首条 user prompt 原样", () => {
    const c = new ContextCompactor();
    const msgs = mk(40);
    msgs[0] = { role: "user", content: "原始任务指令不可变" };
    const r = c.compactByLadder(msgs, 29_000, 30_000);
    expect(JSON.stringify(r.messages[0])).toBe(JSON.stringify(msgs[0]));
  });
});

describe("熔断（A13）", () => {
  it("压缩后不降反升 → 熔断，后续直接返回原消息", () => {
    const c = new ContextCompactor();
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    c.recordResult(msgs, msgs, 25_000, 30_000);
    expect(c.isCircuitOpen()).toBe(true);
    const r = c.compactByLadder(msgs, 25_000, 30_000);
    expect(r.strategy).toBe("circuit-open");
    expect(r.messages).toBe(msgs);
  });
  it("压缩有效 → 不熔断", () => {
    const c = new ContextCompactor();
    const before = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i} ${"y".repeat(100)}` }));
    const after = before.slice(0, 10);
    c.recordResult(before, after, 25_000, 30_000);
    expect(c.isCircuitOpen()).toBe(false);
  });
});

describe("非破坏性快照（A14）", () => {
  it("压缩前保存原消息，可回卷", () => {
    const c = new ContextCompactor();
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    c.compactByLadder(msgs, 28_000, 30_000);
    const snap = c.getLastOriginal();
    expect(snap).toBe(msgs);
  });
});

describe("结果预算迭代（A14）", () => {
  it("压到预算内或达迭代上限", () => {
    const c = new ContextCompactor();
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      role: ("user" as const),
      content: `msg-${i} ${"z".repeat(500)}`,
    }));
    const r = c.compactToBudget(msgs, 40_000, 30_000, 5);
    expect(r.iterations).toBeLessThanOrEqual(5);
    const est = Math.ceil(JSON.stringify(r.messages).length / 4);
    expect(est <= 30_000 || r.iterations === 5).toBe(true);
  });
  it("空/短消息直接返回", () => {
    const c = new ContextCompactor();
    const msgs = [{ role: "user" as const, content: "hi" }];
    const r = c.compactToBudget(msgs, 100, 30_000, 5);
    expect(r.iterations).toBe(0);
    expect(r.messages).toBe(msgs);
  });
});

// ---------- issue #11：autoCompact LLM 摘要接本地 openai 主链路 ----------
describe("autoCompact LLM 摘要（openai/mock/anthropic 三链路）", () => {
  const longMsgs = (n: number): Anthropic.MessageParam[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: `消息内容 ${i}` }));

  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:4100/v1";
    process.env.OPENAI_API_KEY = "test-key";
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  it("openai 链路执行 LLM 摘要：结果入消息、保留最近 6 条、请求非流式", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "SUMMARY-MOCK：关键决策A、变更B" } }] }),
    });
    const client: ApiClient = { type: "openai" };
    const c = new ContextCompactor();
    const msgs = longMsgs(10);

    const out = await c.autoCompact(client, "14b", msgs);

    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("[之前的对话摘要]");
    expect(String(out[0].content)).toContain("SUMMARY-MOCK");
    expect(out).toHaveLength(8); // 1 摘要 + 1 ack + 最近 6
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/chat/completions");
    const body = JSON.parse((init as any).body);
    expect(body.model).toBe("14b"); // 用当前模型，不写死 haiku
    expect(body.stream).toBe(false);
    expect(typeof body.max_tokens).toBe("number");
  });

  it("openai 摘要失败 → 回退 budgetReduction，不抛且不带摘要标记", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const client: ApiClient = { type: "openai" };
    const c = new ContextCompactor();
    const msgs = longMsgs(20);

    const out = await c.autoCompact(client, "14b", msgs);

    expect(out.length).toBeLessThan(msgs.length); // 有削减
    expect(out.some((m) => String(m.content).includes("[之前的对话摘要]"))).toBe(false);
    expect(out[0]).toEqual(msgs[0]); // keep_first
  });

  it("mock 链路：固定摘要、不发网络请求", async () => {
    const client: ApiClient = { type: "mock" };
    const c = new ContextCompactor();
    const out = await c.autoCompact(client, "m", longMsgs(8));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(out[0].content)).toContain("[之前的对话摘要]");
  });

  it("anthropic 链路不回归：走 messages.create", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ANTHROPIC-SUMMARY" }],
    });
    const client = { type: "anthropic", anthropic: { messages: { create } } } as unknown as ApiClient;
    const c = new ContextCompactor();
    const out = await c.autoCompact(client, "claude-x", longMsgs(8));
    expect(create).toHaveBeenCalledTimes(1);
    expect(String(out[0].content)).toContain("ANTHROPIC-SUMMARY");
    expect((create.mock.calls[0][0] as any).model).toBe("claude-x");
  });

  it("短消息（<=6）直接返回原引用", async () => {
    const c = new ContextCompactor();
    const msgs = longMsgs(3);
    const out = await c.autoCompact({ type: "openai" }, "14b", msgs);
    expect(out).toBe(msgs);
  });
});
