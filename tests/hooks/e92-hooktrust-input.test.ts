/**
 * E92 promptHookTrust 粘贴多行解析 + 超时 listener 清理（issue #101）
 *
 * - 粘贴 `y⏎<其它文本>` / 带空格 → 首行解析（parseApprovalAnswer，与 #92 审批一致）
 * - 30s 超时 finish → stdin 上 data/close/end 三处 listener 全部移除（不误吞后续输入）
 * - 超时后来的 stdin 数据 → 无 hookTrust listener 消费
 */
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setTTY(v: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });
}

const hook = { event: "PreToolUse", command: "echo hi" } as any;

function countTrustListeners(): { data: number; close: number; end: number } {
  return {
    data: process.stdin.listenerCount("data"),
    close: process.stdin.listenerCount("close"),
    end: process.stdin.listenerCount("end"),
  };
}

async function withPrompt(fn: () => Promise<void>): Promise<void> {
  setTTY(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await fn();
  } finally {
    setTTY(false);
  }
}

describe("粘贴多行首行解析（与审批 #92 同口径）", () => {
  it("`y⏎其它文本` → true（按首行判定）", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const p = promptHookTrust(hook);
      await new Promise((r) => setTimeout(r, 30));
      process.stdin.emit("data", "y\nsome pasted junk\nmore");
      expect(await p).toBe(true);
    });
  }, 15_000);

  it("`YES  `（尾随空格/大小写）→ true", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const p = promptHookTrust(hook);
      await new Promise((r) => setTimeout(r, 30));
      process.stdin.emit("data", "YES  \n");
      expect(await p).toBe(true);
    });
  }, 15_000);

  it("首行非肯定（`n⏎y`）→ false", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const p = promptHookTrust(hook);
      await new Promise((r) => setTimeout(r, 30));
      process.stdin.emit("data", "n\ny");
      expect(await p).toBe(false);
    });
  }, 15_000);

  it("空行首行（`\\ny`）→ false（首行为空按拒绝）", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const p = promptHookTrust(hook);
      await new Promise((r) => setTimeout(r, 30));
      process.stdin.emit("data", "\ny");
      expect(await p).toBe(false);
    });
  }, 15_000);
});

describe("30s 超时后 stdin listener 全清", () => {
  it("超时 resolve → data/close/end 三处 listener 数回到基线", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const base = countTrustListeners();
      vi.useFakeTimers();
      try {
        const p = promptHookTrust(hook);
        // prompt 完成注册（同步部分）后三处 listener 已挂上
        await vi.advanceTimersByTimeAsync(0);
        const during = countTrustListeners();
        expect(during.data).toBe(base.data + 1);
        expect(during.close).toBe(base.close + 1);
        expect(during.end).toBe(base.end + 1);

        await vi.advanceTimersByTimeAsync(30_001);
        expect(await p).toBe(false);

        const after = countTrustListeners();
        expect(after.data).toBe(base.data);
        expect(after.close).toBe(base.close);
        expect(after.end).toBe(base.end);
      } finally {
        vi.useRealTimers();
      }
    });
  }, 15_000);

  it("超时后 stdin 再来数据 → 无 hookTrust listener 消费（数量不增、不误 pause）", async () => {
    await withPrompt(async () => {
      const { promptHookTrust } = await import("../../src/engine/hook-trust");
      const base = countTrustListeners();
      vi.useFakeTimers();
      try {
        const p = promptHookTrust(hook);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(await p).toBe(false);

        // 超时后再喂数据：不应再有本 prompt 的 listener
        process.stdin.emit("data", "y\n");
        const after = countTrustListeners();
        expect(after.data).toBe(base.data);
        expect(after.close).toBe(base.close);
        expect(after.end).toBe(base.end);
      } finally {
        vi.useRealTimers();
      }
    });
  }, 15_000);
});
