/**
 * G6 gameqa notify：失败任务 webhook（无 URL no-op / payload 组装 / summary 兜底）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { notifyJobFailure } from "../../src/gameqa/notify";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["NOTIFY_WEBHOOK_URL"];
});

describe("notifyJobFailure", () => {
  it("未配置 NOTIFY_WEBHOOK_URL → no-op 不发请求", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    notifyJobFailure({ job_id: 1, platform: "mac" } as never, "a1", { message: "x" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("配置后 POST JSON：event/job_id/text 组装正确，message 优先", async () => {
    process.env["NOTIFY_WEBHOOK_URL"] = "http://127.0.0.1:1/hook";
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    notifyJobFailure({ job_id: 7, platform: "android" } as never, "agent-9", { message: "卡顿率超限 25%" });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/hook");
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload["event"]).toBe("job_failed");
    expect(payload["job_id"]).toBe(7);
    expect(payload["agent_id"]).toBe("agent-9");
    expect(String(payload["text"])).toContain("任务 #7");
    expect(String(payload["text"])).toContain("卡顿率超限 25%");
  });

  it("summary 无 message → JSON 截断兜底进 text", async () => {
    process.env["NOTIFY_WEBHOOK_URL"] = "http://127.0.0.1:1/hook";
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    notifyJobFailure({ job_id: 8, platform: "mac" } as never, "a", { passed: 0, total: 3 });
    await new Promise((r) => setTimeout(r, 0));
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(String(payload["text"])).toContain("passed");
  });
});
