/**
 * N12 路由骨架（A23）：任务画像 + 模型角色制 + routelog 反馈闭环
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  profileTask,
  resolveRoleModel,
  routeTask,
  formatRouteLog,
  appendRouteFeedback,
  readRouteProfile,
  suggestModel,
} = await import("../../src/engine/router");

const mockEnv = { TUPIG_MOCK: "1" } as NodeJS.ProcessEnv;

describe("profileTask 画像", () => {
  it("编辑/搜索/评审/计划/摘要/对话分类", () => {
    expect(profileTask("把 User 模块里的登录函数改成邮箱验证").kind).toBe("edit");
    expect(profileTask("找出所有调用 formatRouteLog 的地方").kind).toBe("search");
    expect(profileTask("评审一下这次未提交的改动").kind).toBe("review");
    expect(profileTask("给缓存层设计一个失效方案").kind).toBe("plan");
    expect(profileTask("总结这轮会话做了什么").kind).toBe("summarize");
    expect(profileTask("解释一下 router.ts 怎么工作").kind).toBe("chat");
  });

  it("难度沿用启发式", () => {
    expect(profileTask("重构跨 5 个文件的错误处理").difficulty).toBe("hard");
    expect(profileTask("读 src/index.ts").difficulty).toBe("easy");
  });

  it("空输入安全", () => {
    const p = profileTask("");
    expect(p.kind).toBe("chat");
    expect(p.difficulty).toBe("easy");
  });
});

describe("resolveRoleModel 角色制", () => {
  it("TUPIG_MODEL_<ROLE> 优先", () => {
    const env = { TUPIG_MODEL_CHAT: "a", TUPIG_MODEL_APPLY: "b", TUPIG_MODEL_SUMMARIZE: "c" } as NodeJS.ProcessEnv;
    expect(resolveRoleModel("chat", env)).toBe("a");
    expect(resolveRoleModel("apply", env)).toBe("b");
    expect(resolveRoleModel("summarize", env)).toBe("c");
  });

  it("TUPIG_ROLE_MODELS JSON 次之", () => {
    const env = { TUPIG_ROLE_MODELS: '{"chat":"x","apply":"y"}' } as NodeJS.ProcessEnv;
    expect(resolveRoleModel("apply", env)).toBe("y");
    expect(resolveRoleModel("summarize", env)).toBeUndefined();
  });

  it("都没配 → undefined", () => {
    expect(resolveRoleModel("chat", {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveRoleModel("chat", { TUPIG_ROLE_MODELS: "{bad" } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("routeTask 角色覆盖与画像建议", () => {
  const localOpenAI = {
    OPENAI_BASE_URL: "http://localhost:4100",
    OPENAI_API_KEY: "k",
  } as NodeJS.ProcessEnv;

  it("apply 角色 env 覆盖难度分流", () => {
    const r = routeTask({
      prompt: "修改登录函数",
      env: { ...localOpenAI, TUPIG_MODEL_APPLY: "role-apply" },
    });
    expect(r.model).toBe("role-apply");
    expect(r.reason).toContain("role");
  });

  it("summarize 角色 env 覆盖", () => {
    const r = routeTask({
      prompt: "总结这段输出",
      env: { ...localOpenAI, TUPIG_MODEL_SUMMARIZE: "role-sum" },
    });
    expect(r.model).toBe("role-sum");
  });

  it("无角色 env 时保持原分流", () => {
    const r = routeTask({ prompt: "读 src/a.ts", env: localOpenAI });
    expect(r.model).toBe("14b");
    expect(r.reason).toContain("easy");
  });

  it("画像建议命中时改选（search→8b）", () => {
    const dir = mkdtempSync(join(tmpdir(), "n12-"));
    try {
      mkdirSync(join(dir, ".tupigcode"), { recursive: true });
      for (let i = 0; i < 4; i++) {
        appendRouteFeedback(dir, { model: "8b", kind: "search", success: true, oneShot: true });
        appendFileSync(
          join(dir, ".tupigcode", "route.log"),
          formatRouteLog({ model: "8b", provider: "local", reason: "easy-本地14b", prompt: "找 x", kind: "search" }) + "\n",
        );
      }
      const r = routeTask({ prompt: "找出所有 TODO", env: localOpenAI, workDir: dir });
      expect(r.model).toBe("8b");
      expect(r.reason).toContain("profile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("routelog 反馈闭环", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "n12b-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("feedback 行写入 route.log", () => {
    appendRouteFeedback(dir, { model: "14b", kind: "edit", success: true, oneShot: true });
    const lines = readFileSync(join(dir, ".tupigcode", "route.log"), "utf-8").trim().split("\n");
    const row = JSON.parse(lines[0]);
    expect(row.type).toBe("feedback");
    expect(row).toMatchObject({ model: "14b", kind: "edit", success: true, oneShot: true });
  });

  it("readRouteProfile 聚合 route 与 feedback", () => {
    appendRouteFeedback(dir, { model: "8b", kind: "search", success: true, oneShot: true });
    appendRouteFeedback(dir, { model: "8b", kind: "search", success: true, oneShot: false });
    appendRouteFeedback(dir, { model: "14b", kind: "edit", success: false, oneShot: false });
    appendFileSync(
      join(dir, ".tupigcode", "route.log"),
      formatRouteLog({ model: "8b", provider: "local", reason: "r", prompt: "p", kind: "search" }) + "\n",
    );
    const p = readRouteProfile(dir);
    expect(p.byKind.search!.feedback).toBe(2);
    expect(p.byKind.search!.oneShot).toBe(1);
    expect(p.byKind.edit!.rate).toBe(0);
    expect(p.totalRoutes).toBe(1);
  });

  it("suggestModel：样本足且一次通过率高才建议", () => {
    expect(suggestModel(profileTask("找出 TODO"), dir)).toBeNull();
    for (let i = 0; i < 3; i++) {
      appendRouteFeedback(dir, { model: "8b", kind: "search", success: true, oneShot: true });
    }
    expect(suggestModel(profileTask("找出 TODO"), dir)).toBe("8b");
    // 样本足够但通过率低 → 不建议
    appendRouteFeedback(dir, { model: "8b", kind: "search", success: false, oneShot: false });
    expect(suggestModel(profileTask("找出 TODO"), dir)).toBeNull();
  });

  it("缺 route.log 时 profile 为空", () => {
    const p = readRouteProfile(join(dir, "nope"));
    expect(p.totalRoutes).toBe(0);
    expect(suggestModel(profileTask("随便"), join(dir, "nope"))).toBeNull();
  });

  it("formatRouteLog 带 kind 字段", () => {
    const row = JSON.parse(formatRouteLog({ model: "m", provider: "local", reason: "r", prompt: "p", kind: "chat" }));
    expect(row.kind).toBe("chat");
    expect(row.prompt).toBe("p");
  });
});
