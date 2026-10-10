/**
 * E80 PackageManager 盲区补测（fix #125）：auto 探测、无项目提示、npm list 离线路径、错误兜底。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PackageListTool, PackageInstallTool, PackageUninstallTool, RunScriptTool } from "../../src/tools/PackageManager";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

const allow: CanUseToolFn = async () => ({ behavior: "allow" });
let dir: string;

function ctx(workDir: string): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir,
    sessionId: "s1",
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-mgr-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PackageList auto 探测", () => {
  it("空目录 → 无法检测项目类型", async () => {
    const r = await PackageListTool.call({ packageManager: "auto" } as never, ctx(dir), allow);
    expect(String(r.data)).toBe("无法检测项目类型");
  });

  it("package.json → npm；requirements.txt → pip", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const r1 = await PackageListTool.call({ packageManager: "auto" } as never, ctx(dir), allow);
    expect(String(r1.data)).not.toBe("无法检测项目类型"); // npm list 在空项目上离线可跑或报错兜底
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-mgr-pip-"));
    try {
      fs.writeFileSync(path.join(dir2, "requirements.txt"), "flask\n");
      const r2 = await PackageListTool.call({ packageManager: "auto" } as never, ctx(dir2), allow);
      expect(String(r2.data)).not.toBe("无法检测项目类型");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("安装/卸载错误兜底（不抛错，结构化失败文案）", () => {
  it("pip install 失败（无 pip 环境也返回失败文案）", async () => {
    const r = await PackageInstallTool.call(
      { packageName: "definitely-not-a-real-pkg-xyz-000", packageManager: "pip" } as never,
      ctx(dir),
      allow,
    );
    expect(String(r.data)).toMatch(/已安装|安装失败/);
  }, 90_000);

  it("pip uninstall 失败文案", async () => {
    const r = await PackageUninstallTool.call(
      { packageName: "definitely-not-a-real-pkg-xyz-000", packageManager: "pip" } as never,
      ctx(dir),
      allow,
    );
    expect(String(r.data)).toMatch(/已卸载|卸载失败|not installed|Cannot uninstall|Skipping/);
  }, 90_000);
});

describe("RunScript 错误兜底", () => {
  it("auto 探测 + npm run 不存在脚本 → 失败文案不抛错", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts: {} }));
    const r = await RunScriptTool.call({ script: "definitely-missing-script", packageManager: "auto" } as never, ctx(dir), allow);
    expect(String(r.data)).toMatch(/脚本执行失败|npm ERR/);
  }, 90_000);

  it("空目录 auto → 无法检测项目类型", async () => {
    const r = await RunScriptTool.call({ script: "x", packageManager: "auto" } as never, ctx(dir), allow);
    expect(String(r.data)).toBe("无法检测项目类型");
  });
});
