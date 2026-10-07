/**
 * E72 issue 清理批次 3（#64 审批串行化）
 *
 * 审查点：并发触发的交互式弹问必须串行——同一时刻只有一个 readline
 * 在等待输入，后续弹问的提示打印要等前一个 settle 之后才出现；
 * 非 TTY 快速拒绝不入队（即时返回，不阻塞在锁上）。
 */
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";

import { promptUserDecision } from "../../src/services/permissions";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  if (desc) Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  delete (process.stdin as any).isTTY;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setTTY(v: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });
}

describe("审批串行化（#64）", () => {
  it("并发两次 TTY 弹问：第二个的提示在第一个 settle 后才打印", async () => {
    setTTY(true);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const p1 = promptUserDecision("Bash", { command: "first" });
      await sleep(40); // 第一个已进入等待
      const p2 = promptUserDecision("Write", { file_path: "/tmp/x" });
      await sleep(40); // 若串行，此刻第二个还没轮到
      const promptsAfterFirst = countPrompts(logs);
      expect(promptsAfterFirst).toBe(1); // 只有第一个的审批提示已打印

      process.stdin.emit("data", "y\n"); // 答第一个
      expect(await p1).toBe("allow");
      await sleep(40); // 第二个获得锁并打印
      expect(countPrompts(logs)).toBe(2);

      process.stdin.emit("data", "y\n");
      expect(await p2).toBe("allow");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it("promptHookTrust 与审批共用同一锁：TOFU 提示等前一个弹问 settle", async () => {
    setTTY(true);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const p1 = promptUserDecision("Bash", { command: "first" });
      await sleep(40);
      const { promptHookTrust } = await import("../../src/engine/hookTrust");
      const p2 = promptHookTrust({ event: "PreToolUse", command: "echo hi" } as any);
      await sleep(40);
      expect(logs.filter((l) => l.includes("hook 首次触发"))).toHaveLength(0); // 锁内排队中
      process.stdin.emit("data", "y\n");
      expect(await p1).toBe("allow");
      await sleep(40);
      expect(logs.filter((l) => l.includes("hook 首次触发"))).toHaveLength(1);
      process.stdin.emit("data", "y\n");
      expect(await p2).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it("非 TTY 立即 deny，不入队不阻塞", async () => {
    setTTY(false);
    const started = Date.now();
    const [a, b] = await Promise.all([
      promptUserDecision("Bash", { command: "x" }),
      promptUserDecision("Bash", { command: "y" }),
    ]);
    expect(a).toBe("deny");
    expect(b).toBe("deny");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("第一个弹问 settle 后释放锁，后续弹问可正常完成", async () => {
    setTTY(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const p1 = promptUserDecision("Bash", { command: "a" });
      await sleep(30);
      process.stdin.emit("data", "\n"); // 空输入 = 拒绝
      expect(await p1).toBe("deny");
      const p2 = promptUserDecision("Bash", { command: "b" });
      await sleep(30);
      process.stdin.emit("data", "y\n");
      expect(await p2).toBe("allow");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);
});

function countPrompts(logs: string[]): number {
  return logs.filter((l) => l.includes("需要审批：")).length;
}
