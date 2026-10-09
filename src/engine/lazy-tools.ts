/**
 * engine/lazyTools.ts — 工具延迟装载（issue #17，CodeBuddy ToolSearch 思路）
 *
 * 核心集常驻注入，其余工具收敛为 ToolSearch 元工具按需检索挂载；
 * TUPIG_EXTRA_TOOLS 显式指定的工具保持常驻（兼容既有语义）；
 * TUPIG_LAZY_TOOLS=0 关闭延迟装载回退全量注入。
 */
import { z } from "zod";
import { buildTool, type Tool, type ToolResult } from "./Tool.js";

/** 常驻核心集：读/写/改/shell + 检索 + 清单 + 提问 */
export const CORE_TOOL_NAMES = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite", "Question",
]);

const META_TOOL_NAME = "ToolSearch";

/** 常用别名（检索时并入 haystack） */
const ALIASES: Record<string, string> = {
  RunTests: "test tests 测试 自验证 验证 跑测试",
  RepoMap: "repo map 仓库 结构 地图 文件树 symbols",
  WebSearch: "web search 网页 搜索 联网",
  GitStatus: "git status 状态 diff 工作区",
  GitDiff: "git diff diff 对比 改动",
  Agent: "agent 子代理 subagent 并行 委派",
  WebFetch: "fetch url 抓取 网页",
  GitCommit: "commit 提交 git 提交",
  GitUndo: "undo reset 撤销 回退",
  MultiEdit: "multi edit 批量编辑 多处替换 bulk edit 原子编辑",
};

let pool: Tool[] = [];
const explicit = new Set<string>();
const loaded = new Set<string>();

export function lazyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TUPIG_LAZY_TOOLS !== "0";
}

export function resetLazyStore(): void {
  pool = [];
  explicit.clear();
  loaded.clear();
}

export function setExplicitExtras(names: string[]): void {
  explicit.clear();
  for (const n of names) explicit.add(n);
}

export function setSearchPool(tools: Tool[]): void {
  pool = [...tools];
}

export function markLoaded(names: string[]): void {
  for (const n of names) loaded.add(n);
}

export function residentNames(): Set<string> {
  const s = new Set<string>(CORE_TOOL_NAMES);
  s.add(META_TOOL_NAME);
  for (const n of explicit) s.add(n);
  for (const n of loaded) s.add(n);
  return s;
}

/** 当轮注入的工具列表；开关关则全量 */
export function promptTools(all: Tool[]): Tool[] {
  if (!lazyEnabled()) return all;
  const res = residentNames();
  return all.filter((t) => res.has(t.name));
}

function haystack(t: Tool): string {
  let desc = "";
  try {
    desc = t.description(t as any);
  } catch { /* 描述求值失败仅影响检索 */ }
  return (t.name + " " + desc + " " + (ALIASES[t.name] ?? "")).toLowerCase();
}

function score(hay: string, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let s = hay.includes(q) ? 6 : 0;
  for (const tok of q.split(/[\s,，、;；]+/).filter(Boolean)) {
    if (tok.length > 1 && hay.includes(tok)) s += 3;
  }
  const runs = q.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (hay.includes(bg)) s += 1;
    }
  }
  return s;
}

/** 在非常驻池中检索，按相关度返回命中（top limit） */
export function searchDeferred(query: string, limit = 5): Tool[] {
  if (!lazyEnabled()) return [];
  const res = residentNames();
  return pool
    .filter((t) => !res.has(t.name))
    .map((t) => ({ t, s: score(haystack(t), query) }))
    .filter((x) => x.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

const ToolSearchInput = z.object({
  query: z.string().min(1).describe("工具能力关键词（中英文皆可，如 'git status'、'测试'、'仓库地图'）"),
});

export const ToolSearchTool = buildTool({
  name: META_TOOL_NAME,
  inputSchema: ToolSearchInput,
  description: () =>
    "按需检索并挂载非常驻工具。核心工具（Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Question）之外的能力" +
    "（如 git、测试、网页、子代理、仓库地图等）先用本工具搜索，命中后下一轮即可直接调用。",
  prompt: () =>
    "需要当前未列出的工具时，先用本工具按能力关键词检索；命中结果会立即挂载（下一轮生效）。未命中请换更通用的关键词重试。",
  userFacingName: () => META_TOOL_NAME,
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async checkPermissions(input) {
    return { behavior: "allow" as const, updatedInput: input };
  },
  async call(input): Promise<ToolResult<string>> {
    const hits = searchDeferred(input.query);
    if (hits.length === 0) {
      const resident = [...residentNames()].sort().join(", ");
      const msg =
        `未命中任何非常驻工具（query: ${input.query}）。请换关键词重试，` +
        `或确认所需能力是否已由常驻工具覆盖。当前常驻：${resident}。\n` +
        `可用 ToolSearch 检索的能力包括：git / 测试 / 网页 / 子代理 / 仓库地图 等。`;
      return { data: msg, resultForAssistant: msg, isError: true };
    }
    markLoaded(hits.map((t) => t.name));
    const lines = hits.map((t) => {
      let d = "";
      try { d = t.description(t as any); } catch { /* ignore */ }
      return `- ${t.name}：${d}`;
    });
    const msg =
      `已挂载 ${hits.length} 个工具（下一轮可用，无需重复检索）：\n` + lines.join("\n");
    return { data: msg, resultForAssistant: msg };
  },
});
