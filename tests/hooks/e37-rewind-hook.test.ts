/**
 * E37 PostRewind hook（issue #34）
 * 成功回滚触发一次（input 含 id+mode）/ 失败不触发 / 抛异常不影响
 */
import { describe, it, expect } from "vitest";
import { HookSystem, type HookContext } from "../../src/engine/hooks";
import { fireRewindPost } from "../../src/engine/hook-events";

function base(): HookContext {
  return { turnNumber: 0, sessionId: "s-rewind" };
}

describe("PostRewind", () => {
  it("回滚成功 → 触发一次，input 含 checkpointId + mode", async () => {
    const hs = new HookSystem();
    const seen: HookContext[] = [];
    hs.register({ event: "PostRewind", handler: (c) => { seen.push(c); } });
    await fireRewindPost(hs, { ok: true, message: "ok" }, { checkpointId: "cp_1", mode: "code" }, base());
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toEqual({ checkpointId: "cp_1", mode: "code" });
    expect(seen[0].sessionId).toBe("s-rewind");
  });

  it("回滚失败 → 不触发", async () => {
    const hs = new HookSystem();
    let fired = 0;
    hs.register({ event: "PostRewind", handler: () => { fired++; } });
    await fireRewindPost(hs, { ok: false, message: "不是 git 仓库" }, { checkpointId: "cp_x", mode: "all" }, base());
    expect(fired).toBe(0);
  });

  it("触发器抛异常 → 静默隔离", async () => {
    const hs = new HookSystem();
    hs.register({ event: "PostRewind", handler: () => { throw new Error("boom"); } });
    await expect(
      fireRewindPost(hs, { ok: true, message: "ok" }, { checkpointId: "cp_1", mode: "chat" }, base()),
    ).resolves.toBeUndefined();
  });
});
