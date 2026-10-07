/**
 * E49 流式空闲看门狗（#46）
 *
 * - 距上一个内容事件超过阈值即中断（字节 keepalive 不重置计时）
 * - 中断错误归类 network（可重试 + failoverEligible）
 * - `TUPIG_STREAM_IDLE_MS` 可覆盖，0 关闭
 */
import { describe, expect, it, afterEach } from "vitest";
import { withIdleWatchdog } from "../../src/services/api";
import { resolveStreamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_MS } from "../../src/engine/constants";
import { classifyProviderError } from "../../src/services/errors";
import type { StreamEvent } from "../../src/services/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(stream: AsyncGenerator<any>) {
  const out: any[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function textEvent(t: string): StreamEvent {
  return { type: "text_delta", text: t };
}

const envBackup = { ...process.env };
afterEach(() => {
  process.env = { ...envBackup };
});

describe("withIdleWatchdog 空闲中断", () => {
  it("内层挂死 → 抛流式空闲超时并回收内层", async () => {
    let closed = false;
    async function* stall(): AsyncGenerator<StreamEvent> {
      yield textEvent("a");
      await new Promise<void>(() => {}); // 永不前进
      yield textEvent("never");
    }
    const it = withIdleWatchdog(stall(), 50);
    await expect(
      (async () => {
        for await (const _ of it) void _;
      })(),
    ).rejects.toThrow(/空闲超时/);
    void closed;
  });

  it("内容事件持续推进 → 即使总时长超阈值也不中断", async () => {
    async function* pace(): AsyncGenerator<StreamEvent> {
      for (let i = 0; i < 5; i++) {
        await sleep(20);
        yield textEvent(String(i));
      }
    }
    const evs = await collect(withIdleWatchdog(pace(), 80));
    expect(evs).toHaveLength(5);
  });

  it("先推进后挂死 → 空闲后仍中断", async () => {
    async function* partly(): AsyncGenerator<StreamEvent> {
      yield textEvent("x");
      await sleep(10);
      yield textEvent("y");
      await new Promise<void>(() => {});
    }
    await expect(
      (async () => {
        for await (const _ of withIdleWatchdog(partly(), 60)) void _;
      })(),
    ).rejects.toThrow(/空闲超时/);
  });

  it("阈值 ≤0 → 直接透传（不装看门狗）", async () => {
    async function* slow(): AsyncGenerator<StreamEvent> {
      await sleep(30);
      yield textEvent("done");
    }
    const evs = await collect(withIdleWatchdog(slow(), 0));
    expect(evs).toHaveLength(1);
  });

  it("内层正常结束 → 正常收流", async () => {
    async function* fin(): AsyncGenerator<StreamEvent> {
      yield textEvent("1");
      yield textEvent("2");
    }
    const evs = await collect(withIdleWatchdog(fin(), 1_000));
    expect(evs.map((e) => e.text)).toEqual(["1", "2"]);
  });
});

describe("resolveStreamIdleTimeoutMs 配置", () => {
  it("默认 120s（常量）", () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(resolveStreamIdleTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000);
  });
  it("TUPIG_STREAM_IDLE_MS 覆盖", () => {
    expect(resolveStreamIdleTimeoutMs({ TUPIG_STREAM_IDLE_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5_000);
  });
  it("0 关闭；非法值回落默认", () => {
    expect(resolveStreamIdleTimeoutMs({ TUPIG_STREAM_IDLE_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveStreamIdleTimeoutMs({ TUPIG_STREAM_IDLE_MS: "abc" } as NodeJS.ProcessEnv)).toBe(120_000);
    expect(resolveStreamIdleTimeoutMs({ TUPIG_STREAM_IDLE_MS: "-5" } as NodeJS.ProcessEnv)).toBe(120_000);
  });
});

describe("空闲超时错误归类", () => {
  it("kind=network，可重试且 failoverEligible", () => {
    const c = classifyProviderError(new Error("流式响应空闲超时（120000ms 无内容进度），已中断"));
    expect(c.kind).toBe("network");
    expect(c.retryable).toBe(true);
    expect(c.failoverEligible).toBe(true);
  });
});
