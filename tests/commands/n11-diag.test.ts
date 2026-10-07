/**
 * N11 命令与诊断（A22）：/doctor 体检 + /init 生成 AGENTS.md + /review 只读评审 prompt
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { runDoctor, renderDoctor, initAgentMd, buildReviewPrompt, REVIEW_DIFF_BUDGET } =
  await import("../../src/commands/diag");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n11-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function byId<T extends { id: string }>(results: T[], id: string): T | undefined {
  return results.find((r) => r.id === id);
}

describe("runDoctor", () => {
  it("mock 环境 provider 检查通过", async () => {
    process.env.TUPIG_MOCK = "1";
    delete process.env.TUPIG_PROVIDER;
    const r = runDoctor(dir);
    expect(byId(r, "provider")?.level).toBe("ok");
  });

  it("非法 TUPIG_PROVIDER → error", () => {
    delete process.env.TUPIG_MOCK;
    process.env.TUPIG_PROVIDER = "bogus";
    const r = runDoctor(dir);
    expect(byId(r, "provider")?.level).toBe("error");
    delete process.env.TUPIG_PROVIDER;
    process.env.TUPIG_MOCK = "1";
  });

  it("缺 OPENAI env 时 provider 为 error 且给中文建议", () => {
    const saved = { ...process.env };
    delete process.env.TUPIG_MOCK;
    delete process.env.TUPIG_PROVIDER;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = runDoctor(dir);
      const p = byId(r, "provider")!;
      expect(p.level).toBe("error");
      expect(p.detail).toMatch(/TUPIG_MOCK|OPENAI|ANTHROPIC/);
    } finally {
      Object.assign(process.env, saved);
      process.env.TUPIG_MOCK = "1";
    }
  });

  it("重复 skill / agent 名 → warn", () => {
    mkdirSync(join(dir, ".tupigcode", "skills", "a"), { recursive: true });
    mkdirSync(join(dir, ".tupigcode", "skills", "b"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "skills", "a", "SKILL.md"), "---\nname: dup\ndescription: d\n---\nbody");
    writeFileSync(join(dir, ".tupigcode", "skills", "b", "SKILL.md"), "---\nname: dup\ndescription: d\n---\nbody");
    mkdirSync(join(dir, ".tupigcode", "agents"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "agents", "x.md"), "---\nname: same\ndescription: d\n---\nb");
    writeFileSync(join(dir, ".tupigcode", "agents", "y.md"), "---\nname: same\ndescription: d\n---\nb");
    const r = runDoctor(dir);
    expect(byId(r, "skill-dup")?.level).toBe("warn");
    expect(byId(r, "agent-dup")?.level).toBe("warn");
  });

  it("hooks.json 存在但 JSON 非法 → warn", () => {
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), "{ not json");
    const r = runDoctor(dir);
    expect(byId(r, "hooks")?.level).toBe("warn");
  });

  it("每项都有 id/level/label，ok 项含 workdir", () => {
    process.env.TUPIG_MOCK = "1";
    const r = runDoctor(dir);
    expect(r.length).toBeGreaterThanOrEqual(5);
    for (const item of r) {
      expect(item.id).toBeTruthy();
      expect(["ok", "warn", "error"]).toContain(item.level);
      expect(item.label).toBeTruthy();
    }
    expect(byId(r, "workdir")?.level).toBe("ok");
  });
});

describe("renderDoctor", () => {
  it("按级别渲染符号与摘要", () => {
    const text = renderDoctor([
      { id: "a", level: "ok", label: "通过项", detail: "" },
      { id: "b", level: "warn", label: "警告项", detail: "d" },
      { id: "c", level: "error", label: "错误项", detail: "e" },
    ]);
    expect(text).toContain("✓");
    expect(text).toContain("!");
    expect(text).toContain("✗");
    expect(text).toMatch(/1 error|1 个错误/);
  });
});

describe("initAgentMd", () => {
  it("生成 AGENTS.md：含项目名/测试命令/目录概览", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-app", version: "2.0.0", scripts: { test: "vitest run", build: "tsc" } }));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    const out = initAgentMd(dir);
    expect(out.path).toContain("AGENTS.md");
    expect(out.created).toBe(true);
    const text = readFileSync(out.path, "utf-8");
    expect(text).toContain("demo-app");
    expect(text).toContain("npm test");
    expect(text).toContain("src/");
  });

  it("已存在则拒绝（force 才覆盖）", () => {
    writeFileSync(join(dir, "AGENTS.md"), "已有内容");
    expect(() => initAgentMd(dir)).toThrow(/已存在/);
    const out = initAgentMd(dir, { force: true });
    expect(out.created).toBe(true);
    expect(readFileSync(out.path, "utf-8")).not.toBe("已有内容");
  });

  it("python 项目提示 pytest", () => {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "pytest.ini"), "[pytest]");
    const text = initAgentMd(dir).content;
    expect(text).toContain("pytest");
  });
});

describe("buildReviewPrompt", () => {
  it("含只读约束与 findings 优先级格式", () => {
    const p = buildReviewPrompt("diff --git a/x b/x\n+line");
    expect(p).toContain("只读");
    expect(p).toContain("P0");
    expect(p).toContain("diff --git");
  });

  it("空 diff 明确说明", () => {
    expect(buildReviewPrompt("")).toMatch(/没有.*改动|无可评审/);
  });

  it("超预算截断", () => {
    const big = "x".repeat(REVIEW_DIFF_BUDGET + 5000);
    const p = buildReviewPrompt(big);
    expect(p.length).toBeLessThan(REVIEW_DIFF_BUDGET + 3000);
    expect(p).toMatch(/截断/);
  });
});

describe("isValidRef（/review ref 白名单）", async () => {
  const { isValidRef } = await import("../../src/commands/diag");
  it("放行正常 ref", () => {
    for (const ok of ["HEAD", "HEAD~1", "main", "a1b2c3d", "feature/x", "v1.0.0"]) {
      expect(isValidRef(ok)).toBe(true);
    }
  });
  it("拒绝注入字符", () => {
    for (const bad of ["HEAD; rm -rf /", "a b", "$(whoami)", "a&&b", "`id`", ""]) {
      expect(isValidRef(bad)).toBe(false);
    }
  });
});
