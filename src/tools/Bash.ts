/**
 * tools/Bash.ts — Shell 命令执行工具
 */
import { z } from "zod";
import { spawn } from "child_process";
import { classifyBash } from "../services/bash-safety.js";
import { resolveSandboxPolicy, checkBashPaths } from "../services/sandbox.js";
import { buildTool, type ToolResult } from "../engine/Tool.js";
import { TOOL_TIMEOUT_MS } from "../engine/constants.js";
import { clipOutput, type ClipKeep } from "../utils/clip-output.js";
import { safePath } from "../utils/path.js";

export const BashInput = z.object({
  command: z.string().describe("要执行的 Bash 命令"),
  workdir: z.string().optional().describe("工作目录（可选）"),
  timeout: z.number().optional().describe("超时时间，单位毫秒（默认 30000）"),
  keep: z.enum(["head", "tail", "both"]).optional()
    .describe("超长输出裁剪保留策略（默认 both 双端保留；head 只保头 / tail 只保尾）"),
});

const SENSITIVE_ENV = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN", "GIT_TOKEN", "NPM_TOKEN",
  "PRIVATE_KEY", "SECRET_KEY", "PASSWORD", "TOKEN",
]);

function sanitizeEnv(): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV.has(key) && !key.includes("SECRET") && !key.includes("PASSWORD") && !key.includes("PRIVATE")) {
      clean[key] = val;
    }
  }
  return clean;
}

export const BashTool = buildTool<string>({
  name: "Bash",
  inputSchema: BashInput,
  description: () => "执行 Bash 命令并返回其输出。",
  prompt: () => "执行 Shell 命令。请谨慎执行破坏性命令。",
  userFacingName: () => "Bash",
  isReadOnly: (input: unknown) => classifyBash(String((input as any)?.command ?? "")) === "safe",
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  isOpenWorld: () => true,

  async checkPermissions(input, ctx) {
    const policy = resolveSandboxPolicy(ctx.workDir);
    if (checkBashPaths(policy, String((input as any).command ?? "")) === "deny") {
      return { behavior: "deny", message: "沙箱策略：命令触及拦截路径" } as any;
    }
    return { behavior: "allow", updatedInput: input };
  },

  async call(input, context): Promise<ToolResult<string>> {
    let workdir: string;
    try {
      workdir = input.workdir ? safePath(context.workDir, input.workdir) : context.workDir;
    } catch (err) {
      return { data: `工作目录验证失败：${err instanceof Error ? err.message : err}` };
    }
    const timeout = input.timeout || TOOL_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn("bash", ["-c", input.command], {
        cwd: workdir,
        env: sanitizeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      const finish = (result: ToolResult<string>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // 超时 = 执行失败（reject → 上层 PostToolUseFailure / is_error tool_result，issue #36）
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch {}
        reject(new Error(`命令执行超时（${timeout}ms）`));
      }, timeout);

      child.on("close", (code) => {
        let result = "";
        if (stdout) result += stdout;
        if (stderr) result += (result ? "\n" : "") + stderr;
        if (!result) result = `（退出码：${code ?? "未知"}）`;
        result = clipOutput(result, (input.keep ?? "both") as ClipKeep).text;
        finish({ data: result });
      });

      child.on("error", (err) => {
        finish({ data: `错误：${err.message}`, isError: true });
      });
    });
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: "tool_result", tool_use_id: toolUseID, content };
  },
});
