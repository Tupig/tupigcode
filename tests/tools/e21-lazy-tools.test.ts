/**
 * E21 工具延迟装载（issue #17，CodeBuddy ToolSearch 思路）
 * 核心集常驻 / 检索命中挂载 / 显式 extras 常驻不回归 / 未命中反馈 / 开关回退
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CORE_TOOL_NAMES, lazyEnabled, resetLazyStore, setExplicitExtras, setSearchPool,
  markLoaded, promptTools, searchDeferred, ToolSearchTool,
} from "../../src/engine/lazy-tools";
import { getDefaultTools } from "../../src/engine/tool-registry";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

const allow: CanUseToolFn = async () => ({ behavior: "allow" as const });
const mkCtx = (): ToolUseContext => ({
  options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
  abortController: new AbortController(),
  readFileState: new Map(),
  getMessages: () => [],
  workDir: process.cwd(),
  sessionId: "s1",
});

beforeEach(() => {
  delete process.env.TUPIG_LAZY_TOOLS;
  resetLazyStore();
  setExplicitExtras([]);
  setSearchPool(getDefaultTools());
});

afterEach(() => {
  delete process.env.TUPIG_LAZY_TOOLS;
  resetLazyStore();
});

describe("核心集常驻", () => {
  it("promptTools 含核心集 + ToolSearch，不含延迟集", () => {
    const names = promptTools(getDefaultTools()).map((t) => t.name);
    for (const c of CORE_TOOL_NAMES) expect(names).toContain(c);
    expect(names).toContain("ToolSearch");
    for (const deferred of ["Agent", "RepoMap", "WebSearch", "GitStatus", "GitDiff", "RunTests"]) {
      expect(names).not.toContain(deferred);
    }
  });

  it("markLoaded 后（MCP/显式加载）进入常驻", () => {
    markLoaded(["GitStatus"]);
    expect(promptTools(getDefaultTools()).map((t) => t.name)).toContain("GitStatus");
  });
});

describe("检索命中挂载", () => {
  it("searchDeferred 命中 git 状态类工具", () => {
    const hits = searchDeferred("git status 仓库状态").map((t) => t.name);
    expect(hits).toContain("GitStatus");
  });

  it("命中后 load → 下一轮 promptTools 含该工具", () => {
    const hits = searchDeferred("测试 自验证").map((t) => t.name);
    expect(hits).toContain("RunTests");
    markLoaded(hits);
    expect(promptTools(getDefaultTools()).map((t) => t.name)).toContain("RunTests");
  });

  it("ToolSearch 调用：返回命中说明 + 已挂载反馈", async () => {
    const out = await ToolSearchTool.call({ query: "仓库结构地图" }, mkCtx(), allow);
    const s = String(out.data);
    expect(s).toContain("RepoMap");
    expect(s).toMatch(/已挂载|已加载/);
    expect(promptTools(getDefaultTools()).map((t) => t.name)).toContain("RepoMap");
  });
});

describe("显式 extras 常驻（TUPIG_EXTRA_TOOLS 兼容）", () => {
  it("显式指定的工具未 load 也常驻注入", () => {
    setExplicitExtras(["WebSearch"]);
    expect(promptTools(getDefaultTools()).map((t) => t.name)).toContain("WebSearch");
  });
});

describe("未命中反馈与开关", () => {
  it("未命中：ToolSearch 返回引导文案而非抛错", async () => {
    const out = await ToolSearchTool.call({ query: "zzz_qqq 不存在的东西" }, mkCtx(), allow);
    const s = String(out.data);
    expect(s).toMatch(/未命中|没有找到/);
    expect(s).toContain("ToolSearch");
  });

  it("TUPIG_LAZY_TOOLS=0 → 关闭延迟，全量常驻", () => {
    process.env.TUPIG_LAZY_TOOLS = "0";
    expect(lazyEnabled()).toBe(false);
    expect(promptTools(getDefaultTools())).toHaveLength(getDefaultTools().length);
  });
});
