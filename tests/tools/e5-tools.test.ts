/**
 * E5 工具裁剪：默认集 8 核心 + Web + Question；重构/分析/包管理入 extras
 */
import { describe, expect, it } from "vitest";
import { getDefaultTools, getExtraTools, getToolByName } from "../../src/engine/toolRegistry";

describe("默认工具集（裁剪 26→13，N7 TodoWrite / N6 Agent / N9 RepoMap）", () => {
  const names = getDefaultTools().map((t) => t.name);

  it("恰为 8 核心 + WebSearch + Question + TodoWrite + RunTests + ToolSearch + Agent + RepoMap + CompactContext", () => {
    expect(names.sort()).toEqual(
      ["Bash", "Edit", "Read", "Write", "Glob", "Grep", "GitStatus", "GitDiff", "WebSearch", "Question", "TodoWrite", "RunTests", "ToolSearch", "Agent", "RepoMap", "CompactContext"].sort(),
    );
  });
  it("重构/分析/包管理类不在默认", () => {
    for (const gone of ["RenameSymbol", "ComplexityAnalysis", "PackageInstall", "GitCommit", "WebFetch", "CodeStats"]) {
      expect(names).not.toContain(gone);
    }
  });
  it("每个工具 schema 完整可注册", () => {
    for (const t of getDefaultTools()) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.call).toBe("function");
    }
  });
  it("getToolByName 命中默认集", () => {
    expect(getToolByName(getDefaultTools(), "Read")?.name).toBe("Read");
    expect(getToolByName(getDefaultTools(), "不存在")).toBeUndefined();
  });
});

describe("extras 可选工具", () => {
  const names = getExtraTools().map((t) => t.name);
  it("包含被裁掉的代表工具", () => {
    for (const kept of ["WebFetch", "GitCommit", "RenameSymbol", "PackageInstall", "CodeStats"]) {
      expect(names).toContain(kept);
    }
  });
  it("与默认集不重叠", () => {
    const def = new Set(getDefaultTools().map((t) => t.name));
    expect(names.some((n) => def.has(n))).toBe(false);
  });
  it("TUPIG_EXTRA_TOOLS=webfetch,gitcommit 精确启用", async () => {
    const { resolveExtraTools } = await import("../../src/engine/toolRegistry");
    process.env.TUPIG_EXTRA_TOOLS = "WebFetch,GitCommit";
    try {
      const extra = resolveExtraTools().map((t) => t.name);
      expect(extra.sort()).toEqual(["GitCommit", "WebFetch"]);
    } finally { delete process.env.TUPIG_EXTRA_TOOLS; }
  });
});
