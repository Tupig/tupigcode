/**
 * E6 系统提示本地化：动态工具列表、原则、可选附加段
 */
import { describe, expect, it } from "vitest";
import { renderSystemPrompt } from "../../src/engine/prompt";
import { getDefaultTools } from "../../src/engine/tool-registry";

describe("renderSystemPrompt", () => {
  const tools = getDefaultTools();

  it("列出全部注册工具（动态，不硬编码）", () => {
    const p = renderSystemPrompt(tools);
    for (const t of tools) {
      expect(p).toContain(t.name);
      expect(p).toContain(t.description({} as never));
    }
  });
  it("不出现已裁剪工具", () => {
    const p = renderSystemPrompt(tools);
    for (const gone of ["RenameSymbol", "ComplexityAnalysis", "PackageInstall", "RunScript"]) {
      expect(p).not.toContain(gone);
    }
  });
  it("包含本地工作原则与中文回复要求", () => {
    const p = renderSystemPrompt(tools);
    expect(p).toContain("先理解意图");
    expect(p).toContain("用用户的语言回复");
  });
  it("projectRules / append 追加生效", () => {
    const p = renderSystemPrompt(tools, {
      rulesText: "\n\n## 项目规则\n必须跑 lint",
      append: "额外指令A",
      stateText: "正在编辑 a.ts",
    });
    expect(p).toContain("必须跑 lint");
    expect(p).toContain("额外指令A");
    expect(p).toContain("正在编辑 a.ts");
  });
  it("空附加段不产生空标题", () => {
    const p = renderSystemPrompt(tools);
    expect(p).not.toContain("## 当前状态");
  });
});
