/**
 * E52 Hook 并行执行 + 最严合并（issue #49）
 *
 * - 同事件多 handler 并行执行（总耗时 ≈ max 而非 sum）
 * - 最严合并：任一 block 即 block，block 的 message 不被后续覆盖
 * - 未 block：message/replacement 注册序第一个非空；additionalContext 拼接
 * - handler 异常隔离：抛错不影响其他结果
 * - 并行下 block 后续 handler 仍继续执行
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";

import { hookSystem } from "../src/engine/hooks";

beforeAll(() => { process.env.TUPIG_MOCK = "1"; });
beforeEach(() => { hookSystem.clear(); });
afterEach(() => { hookSystem.clear(); });

const ctx = { turnNumber: 1, sessionId: "s1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("并行执行", () => {
  it("两个 150ms handler 总耗时接近 max 而非 sum", async () => {
    hookSystem.register({ event: "Stop", handler: async () => { await sleep(150); return {}; } });
    hookSystem.register({ event: "Stop", handler: async () => { await sleep(150); return {}; } });

    const t0 = Date.now();
    await hookSystem.trigger("Stop", ctx);
    const dt = Date.now() - t0;

    expect(dt).toBeGreaterThanOrEqual(140);
    expect(dt).toBeLessThan(280); // 串行会 ≥300
  }, 10_000);

  it("block handler 不短路：后续 handler 仍执行完成", async () => {
    let slowRan = false;
    hookSystem.register({ event: "Stop", handler: () => ({ block: true, message: "快拦" }) });
    hookSystem.register({
      event: "Stop",
      handler: async () => { await sleep(80); slowRan = true; return { message: "慢完" }; },
    });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(slowRan).toBe(true); // 并行语义下照常执行完
    expect(r.block).toBe(true);
    expect(r.message).toBe("快拦");
  }, 10_000);
});

describe("最严合并", () => {
  it("block 优先，message 取 block 者不被后续覆盖", async () => {
    hookSystem.register({ event: "Stop", handler: () => ({ message: "后来者想覆盖" }) });
    hookSystem.register({ event: "Stop", handler: () => ({ block: true, message: "最严拒绝" }) });
    hookSystem.register({ event: "Stop", handler: () => ({ message: "再覆盖" }) });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r.block).toBe(true);
    expect(r.message).toBe("最严拒绝");
  });

  it("两个 block → 注册序第一个的 message", async () => {
    hookSystem.register({ event: "Stop", handler: () => ({ block: true, message: "第一拦" }) });
    hookSystem.register({ event: "Stop", handler: () => ({ block: true, message: "第二拦" }) });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r.block).toBe(true);
    expect(r.message).toBe("第一拦");
  });

  it("未 block：message/replacement 注册序第一个非空", async () => {
    hookSystem.register({ event: "Stop", handler: () => ({ message: "M1", replacement: "R1" }) });
    hookSystem.register({ event: "Stop", handler: () => ({ message: "M2" }) });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r.block).toBeFalsy();
    expect(r.message).toBe("M1");
    expect(r.replacement).toBe("R1");
  });

  it("additionalContext 多 hook 拼接，与 block 共存", async () => {
    hookSystem.register({ event: "Stop", handler: () => ({ additionalContext: "CTX-1" }) });
    hookSystem.register({ event: "Stop", handler: () => ({ additionalContext: "CTX-2" }) });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r.additionalContext).toBe("CTX-1\nCTX-2");
  });
});

describe("异常隔离", () => {
  it("handler 抛错隔离，其余结果保留", async () => {
    hookSystem.register({ event: "Stop", handler: () => { throw new Error("boom"); } });
    hookSystem.register({ event: "Stop", handler: () => ({ message: "存活" }) });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r.message).toBe("存活");
    expect(r.block).toBeFalsy();
  });

  it("全部抛错 → 空结果", async () => {
    hookSystem.register({ event: "Stop", handler: () => { throw new Error("a"); } });
    hookSystem.register({ event: "Stop", handler: () => { throw new Error("b"); } });

    const r = await hookSystem.trigger("Stop", ctx);

    expect(r).toEqual({});
  });
});
