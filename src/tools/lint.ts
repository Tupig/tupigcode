/**
 * 编辑后自动 Lint 检查
 *
 * 灵感来自 SWE-agent 和 Aider。
 * 在 FileEdit / FileWrite 执行后自动运行项目 linter，
 * 将错误信息反馈给模型，形成"编辑→检查→修复"闭环。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);

export interface LintResult {
  success: boolean;
  output: string;
  file?: string;
}

/**
 * 检测项目 linter 并运行
 * @param workDir 工作目录
 * @param filePath 被编辑的文件路径（可选，用于针对性检查）
 * @param timeout 超时时间（毫秒）
 */
export async function runPostEditLint(
  workDir: string,
  filePath?: string,
  timeout = 15_000,
): Promise<LintResult | null> {
  const linter = detectLinter(workDir);
  if (!linter) return null;

  try {
    const args = linter.args(filePath);
    const { stdout, stderr } = await execFileAsync(linter.command, args, {
      cwd: workDir,
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });

    const output = (stderr || stdout || "").trim();
    return {
      success: output.length === 0,
      output,
      file: filePath,
    };
  } catch (err: any) {
    // 非零退出码 = 有 lint 错误
    const output = (err.stderr || err.stdout || err.message || "").trim();
    return {
      success: false,
      output,
      file: filePath,
    };
  }
}

interface LinterDef {
  name: string;
  command: string;
  args: (filePath?: string) => string[];
}

function detectLinter(workDir: string): LinterDef | null {
  // TypeScript: tsc --noEmit
  if (
    existsSync(join(workDir, "tsconfig.json")) ||
    existsSync(join(workDir, "package.json"))
  ) {
    try {
      const pkg = require(join(workDir, "package.json"));
      const hasTsc =
        pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
      if (hasTsc || existsSync(join(workDir, "node_modules/.bin/tsc"))) {
        return {
          name: "tsc",
          command: "npx",
          args: (f) => ["tsc", "--noEmit", "--pretty", ...(f ? [f] : [])],
        };
      }
    } catch {
      // ignore
    }
  }

  // Python: ruff check
  if (existsSync(join(workDir, "ruff.toml")) || existsSync(join(workDir, "pyproject.toml"))) {
    return {
      name: "ruff",
      command: "ruff",
      args: (f) => ["check", "--output-format=text", ...(f ? [f] : [])],
    };
  }

  // Go: go vet
  if (existsSync(join(workDir, "go.mod"))) {
    return {
      name: "go vet",
      command: "go",
      args: () => ["vet", "./..."],
    };
  }

  // Rust: cargo check
  if (existsSync(join(workDir, "Cargo.toml"))) {
    return {
      name: "cargo check",
      command: "cargo",
      args: () => ["check"],
    };
  }

  return null;
}

/**
 * 格式化 lint 结果为工具输出
 */
export function formatLintResult(result: LintResult): string {
  if (result.success) {
    return result.file
      ? `✓ ${result.file} lint 检查通过`
      : "✓ lint 检查通过";
  }
  const header = result.file ? `lint 错误（${result.file}）：` : "lint 错误：";
  return `${header}\n${result.output}`;
}
