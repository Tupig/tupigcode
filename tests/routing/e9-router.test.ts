/**
 * E9 路由器：纯难度分流 + 8b 策略 + 云端回落 + routelog
 */
import { describe, expect, it } from "vitest";
import { estimateDifficulty, routeTask, formatRouteLog } from "../../src/engine/router";

describe("estimateDifficulty 纯启发式", () => {
  it("只读类短指令 → easy", () => {
    expect(estimateDifficulty("读 src/index.ts 看看结构")).toBe("easy");
    expect(estimateDifficulty("列出 src 下的 ts 文件")).toBe("easy");
    expect(estimateDifficulty("grep 一下 TODO")).toBe("easy");
  });
  it("重构/多文件/完整实现 → hard", () => {
    expect(estimateDifficulty("重构整个 services 模块并统一错误处理，涉及所有调用方")).toBe("hard");
    expect(estimateDifficulty("实现一个完整的用户认证系统，含注册登录刷新令牌，跨多文件")).toBe("hard");
    expect(estimateDifficulty("跨 10 个文件迁移 API 版本并修复所有类型错误")).toBe("hard");
  });
  it("空/模糊 → easy（保守走本地）", () => {
    expect(estimateDifficulty("")).toBe("easy");
    expect(estimateDifficulty("hi")).toBe("easy");
  });
});

describe("routeTask 分流", () => {
  const local = { OPENAI_BASE_URL: "http://127.0.0.1:4100/v1", OPENAI_API_KEY: "k" };
  const cloud = { ANTHROPIC_API_KEY: "a" };

  it("显式 model 最高优先", () => {
    const r = routeTask({ prompt: "重构整个模块", model: "30b", env: { ...local, ...cloud } as any });
    expect(r.model).toBe("30b");
    expect(r.reason).toContain("显式");
  });
  it("mock → mock", () => {
    const r = routeTask({ prompt: "读文件", env: { TUPIG_MOCK: "1" } as any });
    expect(r.model).toBe("mock");
  });
  it("easy + 纯本地 → 14b", () => {
    const r = routeTask({ prompt: "读 src/index.ts", env: local as any });
    expect(r.model).toBe("14b");
    expect(r.provider).toBe("local");
  });
  it("easy + 上下文 ≥14k → 8b", () => {
    const r = routeTask({ prompt: "读文件", contextTokens: 15_000, env: local as any });
    expect(r.model).toBe("8b");
  });
  it("hard + 有云凭据 → 云端模型", () => {
    const r = routeTask({ prompt: "重构整个 services 模块并统一错误处理", env: { ...local, ...cloud } as any });
    expect(r.provider).toBe("cloud");
    expect(r.model).toMatch(/claude|cloud/);
  });
  it("hard + 无云凭据 → 本地回落", () => {
    const r = routeTask({ prompt: "重构整个 services 模块并统一错误处理", env: local as any });
    expect(r.provider).toBe("local");
    expect(r.reason).toContain("无云端");
  });
  it("easy + 无任何凭据 → 抛错交给 provider 层", () => {
    expect(() => routeTask({ prompt: "读文件", env: {} as any })).toThrow();
  });
});

describe("formatRouteLog", () => {
  it("单行 JSON 含 model/provider/reason/prompt 摘要", () => {
    const line = formatRouteLog({
      model: "8b", provider: "local", reason: "easy-ctx>=14k",
      prompt: "读 src/index.ts", contextTokens: 15_000, ts: 1000,
    });
    const obj = JSON.parse(line);
    expect(obj.model).toBe("8b");
    expect(obj.provider).toBe("local");
    expect(obj.reason).toBe("easy-ctx>=14k");
    expect(obj.prompt).toContain("读");
    expect(obj.ts).toBe(1000);
  });
  it("prompt 超长截断", () => {
    const line = formatRouteLog({ model: "14b", provider: "local", reason: "x", prompt: "a".repeat(500), ts: 1 });
    expect(JSON.parse(line).prompt.length).toBeLessThanOrEqual(104);
  });
});
