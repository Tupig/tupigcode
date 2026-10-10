/**
 * N14 CLI 进程级冒烟（refs #125 集成缺口5）：
 *   mlx-local（mlxcmd 真入口）help 子进程 exit 0 + USAGE；claude-local 在 HOME 隔离下以「配置文件缺失」退出。
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("mlx-local（mlxcmd 入口）子进程", () => {
  it("help：exit 0 + USAGE 输出", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/mlx-local.ts", "help"], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("用法: mlx-local");
  });

  it("未知命令：exit 1 + 错误提示", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/mlx-local.ts", "definitely-unknown-cmd"], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未知命令");
  });
});

describe("claude-local 子进程（HOME 隔离）", () => {
  it("settings 缺失 → exit 1 + 配置文件缺失（不进入服务启动）", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-home-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/claude-local.ts"], {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, HOME: fakeHome },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("配置文件缺失");
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
