/**
 * tools/Grep.ts — 内容搜索工具
 */
import { z } from "zod";
import { spawn } from "child_process";
import { buildTool, type ToolResult } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";
import { MAX_GREP_RESULTS, TOOL_TIMEOUT_MS, GREP_FALLBACK_TIMEOUT_MS } from "../engine/constants.js";
import { truncationHint } from "../utils/truncation-hint.js";

export const GrepInput = z.object({
  pattern: z.string().describe("用于搜索的正则表达式"),
  path: z.string().optional().describe("搜索目录"),
  include: z.string().optional().describe("要包含的文件 glob（例如 '*.ts'）"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("输出模式（默认：content）"),
  head_limit: z.number().optional().describe("最大结果数（默认 250）"),
  offset: z.number().optional().describe("结果偏移（截断后按此续取，默认 0）"),
});

export type GrepInput = z.infer<typeof GrepInput>;

export const GrepTool = buildTool<string>({
  name: "Grep",
  inputSchema: GrepInput,
  description: () => "使用正则表达式搜索文件内容（基于 ripgrep），返回匹配的文件路径和行号。",
  prompt: () => "使用正则表达式搜索文件内容。可通过 include 参数按文件类型过滤。",
  userFacingName: () => "Grep",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,

  async checkPermissions(input, _ctx) {
    return { behavior: "allow", updatedInput: input };
  },

  async call(input, context): Promise<ToolResult<string>> {
    const searchPath = input.path ? safePath(context.workDir, input.path) : context.workDir;
    const mode = input.output_mode || "content";
    // 非正/非法回退默认（fix #71：负数 truthy 曾 slice 出空页死循环）
    const headLimit =
      typeof input.head_limit === "number" && Number.isFinite(input.head_limit) && input.head_limit > 0
        ? Math.floor(input.head_limit)
        : MAX_GREP_RESULTS;
    const include = input.include || "";

    try {
      new RegExp(input.pattern);
    } catch (e) {
      return { data: `错误：无效的正则表达式「${input.pattern}」：${e instanceof Error ? e.message : e}`, isError: true };
    }

    const args: string[] = [];
    if (mode === "files_with_matches") args.push("-l");
    else if (mode === "count") args.push("-c");

    args.push("--glob", "!.git", "--glob", "!.svn", "--glob", "!.hg");
    if (include) args.push("--glob", include);
    args.push("--max-columns", "500", "-n", input.pattern, searchPath);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ToolResult<string>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // rg 与 find+grep fallback 共用：格式化 + 分页截断 + 续取交接（issue #56）
      const format = (raw: string): ToolResult<string> => {
        const lines = raw.trim().split("\n").filter(Boolean);
        if (!lines.length) return { data: `未找到匹配「${input.pattern}」的结果` };
        const offset = Math.max(0, input.offset ?? 0);
        if (offset > 0 && offset >= lines.length) {
          return { data: `未找到更多结果（offset=${offset}，共 ${lines.length} 条匹配）` };
        }
        const page = lines.slice(offset, offset + headLimit);
        const truncated = lines.length > offset + headLimit;

        if (mode === "content" && truncated && offset === 0) {
          // SWE-agent 做法：超量且散在多文件 → 只列文件名，逼模型缩窄条件
          const files = [...new Set(lines.map((l) => l.split(":")[0]))];
          if (files.length > 10) {
            return {
              data:
                `匹配 ${lines.length} 行、散在 ${files.length} 个文件，超出显示预算。\n` +
                `涉及文件：\n${files.slice(0, 50).join("\n")}\n` +
                `（先按文件名定位，再用 include / 更精确 pattern / output_mode=files_with_matches 缩窄）`,
            };
          }
        }

        let result: string;
        if (mode === "files_with_matches") {
          result = `找到 ${page.length} 个文件：\n${page.join("\n")}`;
        } else if (mode === "count") {
          result = `匹配数：\n${page.join("\n")}`;
        } else {
          result = `找到 ${page.length} 处匹配：\n${page.join("\n")}`;
        }
        if (truncated) {
          result += "\n" + truncationHint({
            total: lines.length, shown: page.length, offset, limit: headLimit,
          });
        }
        return { data: result };
      };

      // ENOENT 时 error 后仍会触发 close（实测 error → close:-2），
      // 必须屏蔽 rg 的空 close，否则 fallback 结果会被先 settle 丢弃
      let rgFailed = false;
      const child = spawn("rg", args, { timeout: TOOL_TIMEOUT_MS });
      let stdout = "";
      let stderr = "";
      // 输出累积封顶（fix #122）：海量匹配防 OOM
      const OUTPUT_CAP = 4 << 20;
      let dropped = 0;
      const capAppend = (cur: string, curBytes: number, d: Buffer): [string, number, number] => {
        if (curBytes >= OUTPUT_CAP) return [cur, curBytes, d.length];
        const room = OUTPUT_CAP - curBytes;
        const take = d.length > room ? d.subarray(0, room) : d;
        return [cur + take.toString(), curBytes + take.length, d.length - take.length];
      };
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout.on("data", (d: Buffer) => {
        const [s, b, x] = capAppend(stdout, stdoutBytes, d);
        stdout = s;
        stdoutBytes = b;
        dropped += x;
      });
      child.stderr.on("data", (d: Buffer) => {
        const [s, b, x] = capAppend(stderr, stderrBytes, d);
        stderr = s;
        stderrBytes = b;
        dropped += x;
      });

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish({ data: "错误：搜索超时", isError: true });
      }, TOOL_TIMEOUT_MS + 5000);

      child.on("close", () => {
        if (rgFailed) return;
        if (stderr && !stdout) {
          finish({ data: `错误：${stderr.trim()}`, isError: true });
          return;
        }
        finish(format(stdout + (dropped > 0 ? `\n（输出超出 ${OUTPUT_CAP} 字节上限，已丢弃 ${dropped} 字节）` : "")));
      });

      child.on("error", () => {
        if (rgFailed) return;
        rgFailed = true;
        const findArgs = [searchPath, "-type", "f"];
        if (include) findArgs.push("-name", include);
        findArgs.push("-exec", "grep", "-Hn", "--", input.pattern, "{}", "+");

        let fbFailed = false;
        const fallback = spawn("find", findArgs, { timeout: GREP_FALLBACK_TIMEOUT_MS });
        let out = "";
        fallback.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        fallback.stderr.on("data", () => {});
        fallback.on("close", () => {
          if (fbFailed) return;
          finish(format(out));
        });
        fallback.on("error", () => {
          fbFailed = true;
          finish({ data: "错误：ripgrep 和 find+grep 均不可用", isError: true });
        });
      });
    });
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: "tool_result", tool_use_id: toolUseID, content };
  },
});
