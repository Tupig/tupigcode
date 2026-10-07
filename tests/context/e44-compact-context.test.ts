/**
 * E44 CompactContext 模型主动压缩工具（issue #41）
 * 工具置信号+focus 透传 / mock 端到端下一轮前压缩（source=model）/ hook 触发
 */
import { describe, it, expect, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

describe("CompactContext 工具", () => {
  it("call → requestCompaction(focus)，返回排队说明", async () => {
    const { CompactContextTool } = await import("../../src/tools/CompactContext");
    let got: string | undefined;
    const r = await CompactContextTool.call(
      { focus: "登录流程" } as any,
      { requestCompaction: (f?: string) => { got = f; } } as any,
    );
    expect(got).toBe("登录流程");
    expect(r.data).toContain("下一轮");
    expect(r.data).toContain("压缩");
    expect(CompactContextTool.isReadOnly({} as any)).toBe(true);
  });

  it("无 requestCompaction 的上下文（如子代理外部）→ 返回降级说明不崩", async () => {
    const { CompactContextTool } = await import("../../src/tools/CompactContext");
    const r = await CompactContextTool.call({} as any, {} as any);
    expect(r.data).toContain("压缩");
  });
});

describe("mock 端到端：模型主动压缩", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("下一轮前执行压缩（source=model），PreCompact/PostCompact 各触发一次", async () => {
    process.env.TUPIG_MOCK = "1";
    const { query } = await import("../../src/engine/QueryEngine");
    const { hookSystem } = await import("../../src/engine/hooks");
    const { appStore } = await import("../../src/state/AppState");
    appStore.setState((s) => ({ ...s, lastCompaction: undefined, compactionCount: 0 }));

    const pre: any[] = [];
    const post: any[] = [];
    hookSystem.register({ event: "PreCompact", handler: (c) => { pre.push(c); } });
    hookSystem.register({ event: "PostCompact", handler: (c) => { post.push(c); } });

    const seed: Anthropic.MessageParam[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `历史第 ${i} 轮，内容 ${"丰富细节 ".repeat(30)}`,
    }));

    try {
      let result: any = null;
      const iter = query({
        prompt: "压缩上下文",
        initialMessages: seed,
        options: { cwd: process.cwd(), model: "mock" },
      });
      for await (const msg of iter as any) {
        if (msg.type === "result") result = msg;
      }
      expect(result?.subtype).toBeTruthy();

      const rec = appStore.getState().lastCompaction;
      expect(rec).toBeTruthy();
      expect(rec!.source).toBe("model");
      expect(rec!.before).toBeGreaterThan(rec!.after);
      expect(appStore.getState().compactionCount).toBeGreaterThanOrEqual(1);

      expect(pre.length).toBeGreaterThanOrEqual(1);
      expect(post.length).toBeGreaterThanOrEqual(1);
      expect(pre[0].source).toBe("model");
      expect(post[0].source).toBe("model");
    } finally {
      hookSystem.clear();
      appStore.setState((s) => ({ ...s, lastCompaction: undefined, compactionCount: 0 }));
    }
  }, 25_000);
});
