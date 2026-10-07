/**
 * E19 auto-test 自验证循环（issue #15）：测试命令探测 + 执行回喂 + RunTests 工具
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectTestCommand, runAutoTest } from "../../src/tools/testRun";
import { RunTestsTool } from "../../src/tools/testRun";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

let dir: string;

function writePkg(workDir: string, scripts: Record<string, string>) {
  fs.writeFileSync(path.join(workDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts }));
}

const allow: CanUseToolFn = async () => ({ behavior: "allow" as const });
const mkCtx = (workDir: string): ToolUseContext => ({
  options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
  abortController: new AbortController(),
  readFileState: new Map(),
  getMessages: () => [],
  workDir,
  sessionId: "s1",
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-test-"));
  delete process.env.TUPIG_TEST_CMD;
  delete process.env.TUPIG_TEST_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.TUPIG_TEST_CMD;
  delete process.env.TUPIG_TEST_TIMEOUT_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("detectTestCommand 测试命令探测", () => {
  it("TUPIG_TEST_CMD 显式指定优先", () => {
    process.env.TUPIG_TEST_CMD = "echo custom-suite";
    expect(detectTestCommand(dir)).toContain("custom-suite");
  });

  it("package.json 有效 test script → npm test", () => {
    writePkg(dir, { test: "node -e 'console.log(1)'" });
    expect(detectTestCommand(dir)).toBe("npm test");
  });

  it("npm init 占位 test script → 跳过返回 null", () => {
    writePkg(dir, { test: "echo \"Error: no test specified\" && exit 1" });
    expect(detectTestCommand(dir)).toBeNull();
  });

  it("pytest 项目（pyproject + tests/）→ pytest", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    fs.mkdirSync(path.join(dir, "tests"));
    expect(detectTestCommand(dir)).toContain("pytest");
  });

  it("cargo 项目 → cargo test", () => {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    expect(detectTestCommand(dir)).toBe("cargo test");
  });

  it("无任何测试配置 → null", () => {
    expect(detectTestCommand(dir)).toBeNull();
  });
});

describe("runAutoTest 执行与回喂", () => {
  it("测试通过 → success + 输出", async () => {
    writePkg(dir, { test: "node -e 'console.log(\"ok-42\")'" });
    const r = await runAutoTest(dir);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.output).toContain("ok-42");
  });

  it("测试失败 → success:false + 错误输出（回喂修复）", async () => {
    writePkg(dir, { test: "node -e 'console.error(\"boom-expected\"); process.exit(1)'" });
    const r = await runAutoTest(dir);
    expect(r!.success).toBe(false);
    expect(r!.output).toContain("boom-expected");
  });

  it("超长输出 → 尾部截断并标记", async () => {
    writePkg(dir, { test: "node -e 'for(let i=0;i<6000;i++) process.stdout.write(\"L\"+i+\" \")'" });
    const r = await runAutoTest(dir);
    expect(r!.output.length).toBeLessThan(6000);
    expect(r!.output).toContain("已截断");
  });

  it("超时 → success:false 且标明超时", async () => {
    process.env.TUPIG_TEST_TIMEOUT_MS = "300";
    writePkg(dir, { test: "node -e 'setTimeout(()=>{},10000)'" });
    const r = await runAutoTest(dir);
    expect(r!.success).toBe(false);
    expect(r!.output).toContain("超时");
  }, 15_000);

  it("无测试命令 → null", async () => {
    expect(await runAutoTest(dir)).toBeNull();
  });
});

describe("RunTests 工具", () => {
  it("注册名 RunTests、只读（plan 也可验证）", () => {
    expect(RunTestsTool.name).toBe("RunTests");
    expect(RunTestsTool.isReadOnly({})).toBe(true);
  });

  it("通过 → 输出带 ✓ 测试通过", async () => {
    writePkg(dir, { test: "node -e 'console.log(\"all pass\")'" });
    const out = await RunTestsTool.call({}, mkCtx(dir), allow);
    expect(String(out.data)).toContain("✓ 测试通过");
    expect(String(out.data)).toContain("all pass");
  });

  it("失败 → 明确失败回喂 + 修复引导", async () => {
    writePkg(dir, { test: "node -e 'console.error(\"3 failed\"); process.exit(1)'" });
    const out = await RunTestsTool.call({}, mkCtx(dir), allow);
    const s = String(out.data);
    expect(s).toContain("测试未通过");
    expect(s).toContain("3 failed");
    expect(s).toMatch(/修复|fix/);
  });

  it("未检测到命令 → 提示配置 TUPIG_TEST_CMD", async () => {
    const out = await RunTestsTool.call({}, mkCtx(dir), allow);
    expect(String(out.data)).toContain("TUPIG_TEST_CMD");
  });
});
