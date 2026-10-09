/**
 * tools/FileWrite.ts — 文件写入工具
 */
import { MAX_RESULT_CHARS } from "../engine/constants.js";
import { z } from "zod";
import { mkdir, stat } from "fs/promises";
import { dirname } from "path";
import { buildTool, type ToolResult } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";
import { runPostEditLint, formatLintResult } from "./lint.js";
import { writeWithRollback } from "./rollback.js";
import { resolveSandboxPolicy, checkPath } from "../services/sandbox.js";
import { pushTurnOp } from "../engine/diff-review.js";

export const FileWriteInput = z.object({
  file_path: z.string().describe("文件路径"),
  content: z.string().describe("要写入的内容"),
});

export const FileWriteTool = buildTool<string>({
  name: "Write",
  inputSchema: FileWriteInput,
  maxResultSizeChars: MAX_RESULT_CHARS,
  description: () => "将内容写入文件。自动创建父目录，覆盖已有内容。",
  prompt: () => "将内容写入文件，内容会覆盖文件中的现有内容。",
  userFacingName: () => "Write",
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,

  async checkPermissions(input, ctx) {
    const policy = resolveSandboxPolicy(ctx.workDir);
    if (checkPath(policy, safePath(ctx.workDir, (input as any).file_path), "write") === "deny") {
      return { behavior: "deny", message: "沙箱策略：目标路径不可写（仅允许工作目录与 TUPIG_SANDBOX_WRITE 白名单）" } as any;
    }
    return { behavior: "allow", updatedInput: input };
  },

  async call(input, context): Promise<ToolResult<string>> {
    const resolved = safePath(context.workDir, input.file_path);

    await mkdir(dirname(resolved), { recursive: true });
    const r = await writeWithRollback(resolved, input.content, () =>
      runPostEditLint(context.workDir, resolved),
    );
    if (!r.ok) {
      const msg = `${r.error}\n${formatLintResult(r.lint!)}\n请修正后重试，本次写入未生效。`;
      return { data: msg, resultForAssistant: msg, isError: true };
    }

    pushTurnOp({ path: resolved, before: r.prev, after: input.content });

    const s = await stat(resolved);
    context.readFileState.set(resolved, { mtime: s.mtimeMs });

    const lines = input.content.split("\n").length;
    const lintMsg = r.lint ? "\n" + formatLintResult(r.lint) : "";
    const result = `已写入 ${lines} 行至 ${resolved}${lintMsg}`;
    return { data: result, resultForAssistant: result };
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: "tool_result", tool_use_id: toolUseID, content };
  },
});
