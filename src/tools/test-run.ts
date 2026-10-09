/**
 * tools/testRun.ts — auto-test 自验证循环（P6 / issue #15）
 *
 * 灵感来自 aider 的 auto-test 与 SWE-agent 的 validation 回馈：
 * 模型编辑/修复后自主调用 RunTests，失败输出回喂形成
 * "编辑 → 验证 → 修复 → 复跑"闭环，受既有 doom loop 约束。
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { buildTool, type ToolResult } from "../engine/Tool.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 4000;

export interface AutoTestResult {
  success: boolean;
  output: string;
  command: string;
}

/** 探测项目测试命令；显式 TUPIG_TEST_CMD 优先 */
export function detectTestCommand(workDir: string): string | null {
  const explicit = process.env.TUPIG_TEST_CMD?.trim();
  if (explicit) return explicit;

  const pkgPath = join(workDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const test = pkg?.scripts?.test;
      if (typeof test === "string" && test.trim() && !/no test specified/i.test(test)) {
        return "npm test";
      }
    } catch { /* package.json 损坏则跳过 */ }
  }

  if (
    existsSync(join(workDir, "pyproject.toml")) ||
    existsSync(join(workDir, "pytest.ini"))
  ) {
    return "pytest -q";
  }
  if (existsSync(join(workDir, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(workDir, "go.mod"))) return "go test ./...";

  return null;
}

function tailTruncate(output: string): string {
  if (output.length <= MAX_OUTPUT) return output;
  return `…（前段已截断）…` + output.slice(-MAX_OUTPUT);
}

/** 执行测试；无测试命令返回 null（零变化） */
export async function runAutoTest(
  workDir: string,
  timeout = Number(process.env.TUPIG_TEST_TIMEOUT_MS ?? 120_000),
): Promise<AutoTestResult | null> {
  const command = detectTestCommand(workDir);
  if (!command) return null;

  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: workDir,
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const output = tailTruncate([stdout, stderr].filter(Boolean).join("\n").trim());
    return { success: true, output: output || "(无输出)", command };
  } catch (err: any) {
    if (err.killed || err.signal === "SIGTERM") {
      return {
        success: false,
        command,
        output: `测试超时（${timeout}ms，可调 TUPIG_TEST_TIMEOUT_MS）：\n` +
          tailTruncate([err.stdout, err.stderr].filter(Boolean).join("\n").trim()),
      };
    }
    const output = tailTruncate(
      [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim(),
    );
    return { success: false, output, command };
  }
}

const RunTestsInput = z.object({});

export const RunTestsTool = buildTool({
  name: "RunTests",
  inputSchema: RunTestsInput,
  description: () =>
    "运行项目测试套件自验证。编辑/修复代码后应调用：通过则确认完成，失败则依据输出继续修复后复跑，直至全绿。",
  prompt: () =>
    "对本次改动做闭环验证：跑测试 → 失败读输出定位 → 修复 → 复跑。失败输出已附在结果中，勿重复询问；无测试命令时会提示配置 TUPIG_TEST_CMD。",
  userFacingName: () => "RunTests",
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async checkPermissions(input) {
    return { behavior: "allow" as const, updatedInput: input };
  },
  async call(_input, context): Promise<ToolResult<string>> {
    const r = await runAutoTest(context.workDir);
    if (!r) {
      const msg =
        "未检测到测试命令。可设置环境变量 TUPIG_TEST_CMD（如 `TUPIG_TEST_CMD=\"npm run test:unit\"`），" +
        "或在 package.json 配置有效 test script（当前无/为占位）。";
      return { data: msg, resultForAssistant: msg, isError: true };
    }
    if (r.success) {
      const msg = `✓ 测试通过（${r.command}）\n${r.output}`;
      return { data: msg, resultForAssistant: msg };
    }
    const msg =
      `✗ 测试未通过（${r.command}）：\n${r.output}\n\n` +
      "请根据以上输出定位并修复问题，修复后再次调用 RunTests 复跑验证。";
    return { data: msg, resultForAssistant: msg, isError: true };
  },
});
