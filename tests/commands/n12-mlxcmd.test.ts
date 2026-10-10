/**
 * N12 mlxcmd CLI 冒烟（fix #125 盲区）：help 不抛、USAGE 完整、model list 不炸。
 * 经导出的 runMlxCmd(argv) 进程内驱动，不 spawn。
 */
import { describe, expect, it, vi, afterEach } from "vitest";

const { runMlxCmd } = await import("../../src/cli/mlxcmd");

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => {
    chunks.push(String(s));
    return true;
  }) as never);
  await fn();
  return chunks.join("");
}

describe("mlxcmd 冒烟", () => {
  it("help / -h / --help 输出 USAGE 且不抛", async () => {
    for (const flag of [["help"], ["-h"], ["--help"]]) {
      const out = await captureStdout(() => runMlxCmd(flag));
      expect(out).toContain("用法: mlx-local");
      expect(out).toContain("model list");
      expect(process.exitCode ?? 0).toBe(0);
    }
  });

  it("model list：读 models.json 不抛错（exitCode 为 0/1 语义）", async () => {
    await captureStdout(() => runMlxCmd(["model", "list"]));
    expect([0, 1]).toContain(Number(process.exitCode ?? 0));
  });

  it("model 缺省 action 等价 list（action 默认 list 分支）", async () => {
    const out = await captureStdout(() => runMlxCmd(["model"]));
    expect(out).toContain("可用模型");
  });

  it("model info 已知别名：目录未下载返回 1、已下载返回 0，均不抛", async () => {
    await captureStdout(() => runMlxCmd(["model", "info", "8b"]));
    expect([0, 1]).toContain(Number(process.exitCode ?? 0));
  });
});
