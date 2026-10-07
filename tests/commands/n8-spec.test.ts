/**
 * N8 spec 三件套（A17）：requirements/design/tasks + 依赖 wave + plan 批准门禁
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  createSpec,
  listSpecs,
  loadSpec,
  parseTasks,
  buildWaves,
  validatePlan,
  approveSpec,
  SPEC_FILES,
} = await import("../../src/modes/spec");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n8-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createSpec", () => {
  it("生成 requirements/design/tasks 三件套", () => {
    const spec = createSpec(dir, "auth", "实现登录");
    expect(spec.dir).toContain(join(".tupigcode", "specs", "auth"));
    for (const f of Object.values(SPEC_FILES)) {
      expect(existsSync(join(spec.dir, f))).toBe(true);
    }
    expect(readFileSync(join(spec.dir, SPEC_FILES.requirements), "utf-8")).toContain("实现登录");
  });

  it("非法名字拒绝（穿越/斜杠/空）", () => {
    for (const bad of ["", "..", "a/b", "a\\b", "../x"]) {
      expect(() => createSpec(dir, bad, "t")).toThrow();
    }
  });

  it("重复创建拒绝", () => {
    createSpec(dir, "auth", "x");
    expect(() => createSpec(dir, "auth", "x")).toThrow(/已存在/);
  });
});

describe("parseTasks", () => {
  it("解析任务行与状态", () => {
    const tasks = parseTasks(`# 任务
- [ ] T1 写 schema
- [x] T2 建表
普通说明行
`);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "T1", content: "写 schema", status: "pending" });
    expect(tasks[1].status).toBe("done");
  });

  it("解析 @depends 依赖", () => {
    const tasks = parseTasks(`- [ ] T2 接口 @depends T1,T0
- [ ] T1 数据层
- [ ] T0 调研
`);
    expect(tasks[0].depends).toEqual(["T1", "T0"]);
  });

  it("缺 id 的任务行忽略", () => {
    expect(parseTasks("- [ ] 只有内容没有编号\n")).toHaveLength(0);
  });
});

describe("buildWaves", () => {
  const p = (s: string) => parseTasks(s);

  it("无依赖 → 全在第一层", () => {
    const w = buildWaves(p("- [ ] T1 a\n- [ ] T2 b\n"));
    expect(w).toHaveLength(1);
    expect(w[0].map((t) => t.id).sort()).toEqual(["T1", "T2"]);
  });

  it("链式依赖分层", () => {
    const w = buildWaves(p("- [ ] T1 a\n- [ ] T2 b @depends T1\n- [ ] T3 c @depends T2\n"));
    expect(w.map((l) => l.map((t) => t.id))).toEqual([["T1"], ["T2"], ["T3"]]);
  });

  it("菱形依赖：同层并行", () => {
    const w = buildWaves(
      p("- [ ] T1 a\n- [ ] T2 b @depends T1\n- [ ] T3 c @depends T1\n- [ ] T4 d @depends T2,T3\n"),
    );
    expect(w.map((l) => l.map((t) => t.id))).toEqual([["T1"], ["T2", "T3"], ["T4"]]);
  });

  it("环不死循环，环内任务落最后一层", () => {
    const w = buildWaves(p("- [ ] T1 a @depends T2\n- [ ] T2 b @depends T1\n"));
    expect(w.length).toBeLessThanOrEqual(3);
    expect(w.flat().map((t) => t.id).sort()).toEqual(["T1", "T2"]);
  });

  it("依赖不存在的任务视为无依赖", () => {
    const w = buildWaves(p("- [ ] T1 a @depends NOPE\n"));
    expect(w).toHaveLength(1);
  });
});

describe("validatePlan", () => {
  it("缺步骤拒绝", () => {
    const r = validatePlan("# 计划\n## 目标\nx\n## 涉及文件\n- a.ts\n## 风险\n无\n");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("步骤");
  });
  it("缺涉及文件拒绝", () => {
    const r = validatePlan("# 计划\n## 目标\nx\n## 步骤\n1. a\n## 风险\n无\n");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("涉及文件");
  });
  it("结构齐全通过", () => {
    const r = validatePlan(
      "# 计划\n## 目标\n做登录\n## 涉及文件\n- src/a.ts\n## 步骤\n1. 建 schema\n2. 接口\n## 风险\n- 迁移回滚\n",
    );
    expect(r.ok).toBe(true);
  });
});

describe("approveSpec / listSpecs / loadSpec", () => {
  it("三件套齐 + plan 合规 → 批准，落 approved 状态", () => {
    const spec = createSpec(dir, "auth", "实现登录");
    writeFileSync(
      join(spec.dir, "plan.md"),
      "# 计划\n## 目标\nx\n## 涉及文件\n- a.ts\n## 步骤\n1. s\n## 风险\n无\n",
    );
    writeFileSync(
      join(spec.dir, SPEC_FILES.requirements),
      "# 需求\n用户可用账号密码登录\n",
    );
    writeFileSync(join(spec.dir, SPEC_FILES.tasks), "# 任务\n- [ ] T1 建表\n");
    const r = approveSpec(dir, "auth");
    expect(r.ok).toBe(true);
    expect(readFileSync(join(spec.dir, "status.json"), "utf-8")).toContain("approved");
  });

  it("缺 plan 或结构不合规 → 拒绝并给出错误", () => {
    const spec = createSpec(dir, "auth", "x");
    const r = approveSpec(dir, "auth");
    expect(r.ok).toBe(false);
    expect(r.errors.join().length).toBeGreaterThan(0);
    void spec;
  });

  it("requirements 为空 → 拒绝", () => {
    const spec = createSpec(dir, "auth", "x");
    writeFileSync(
      join(spec.dir, "plan.md"),
      "# 计划\n## 目标\nx\n## 涉及文件\n- a.ts\n## 步骤\n1. s\n## 风险\n无\n",
    );
    writeFileSync(join(spec.dir, SPEC_FILES.requirements), "# 需求\n\n");
    const r = approveSpec(dir, "auth");
    expect(r.ok).toBe(false);
    void spec;
  });

  it("listSpecs 统计任务进度，loadSpec 返回三件内容", () => {
    const spec = createSpec(dir, "auth", "x");
    writeFileSync(join(spec.dir, SPEC_FILES.tasks), "- [ ] T1 a\n- [x] T2 b\n");
    const list = listSpecs(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "auth", tasksDone: 1, tasksTotal: 2, status: "draft" });
    const loaded = loadSpec(dir, "auth");
    expect(loaded.tasks).toContain("T2");
    expect(loaded.requirements).toBeTruthy();
  });
});

describe("plan 模式下唯一可写面：.tupigcode/ 计划产物", () => {
  const makeCtx = (mode: string) => ({ mode }) as any;

  it("plan 模式允许写 .tupigcode/specs 下的 plan.md", async () => {
    const { canUseTool } = await import("../../src/services/permissions");
    const r = await canUseTool(
      "Write",
      { file_path: join(dir, ".tupigcode", "specs", "auth", "plan.md"), content: "x" },
      { isReadOnly: () => false, isDestructive: () => false } as any,
      makeCtx("plan"),
    );
    expect(r.behavior).toBe("allow");
  });

  it("plan 模式仍拒绝对源码写入", async () => {
    const { canUseTool } = await import("../../src/services/permissions");
    const r = await canUseTool(
      "Edit",
      { file_path: join(dir, "src", "a.ts"), old_string: "a", new_string: "b" },
      { isReadOnly: () => false, isDestructive: () => false } as any,
      makeCtx("plan"),
    );
    expect(r.behavior).toBe("deny");
  });

  it("plan 模式拒绝写 .tupigcode 之外的路径（含 ../ 逃逸）", async () => {
    const { canUseTool } = await import("../../src/services/permissions");
    for (const p of [join(dir, "README.md"), join(dir, ".tupigcode", "..", "evil.ts")]) {
      const r = await canUseTool(
        "Write",
        { file_path: p, content: "x" },
        { isReadOnly: () => false, isDestructive: () => false } as any,
        makeCtx("plan"),
      );
      expect(r.behavior).toBe("deny");
    }
  });
});

describe("plan 阶段指引注入系统提示", () => {
  it("planSpec 提供时注入 5 阶段与路径", async () => {
    const { renderSystemPrompt } = await import("../../src/engine/prompt");
    const p = renderSystemPrompt([], { planSpec: "auth" });
    expect(p).toContain("Plan 模式");
    expect(p).toContain(".tupigcode/specs/auth/plan.md");
    expect(p).toContain("涉及文件");
    expect(p).toContain("/spec approve");
  });
  it("非 plan 模式不注入", async () => {
    const { renderSystemPrompt } = await import("../../src/engine/prompt");
    expect(renderSystemPrompt([], {})).not.toContain("Plan 模式");
  });
});
