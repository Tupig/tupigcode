/**
 * I2 技能：披露预算 + 三重门禁 + 技能包（A12）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadSkills, formatSkillCatalog, resolveSkill, SKILL_CATALOG_BUDGET } from "../../src/knowledge/skills";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-sk-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function mkSkill(name: string, frontmatter: string, body: string) {
  const d = path.join(dir, ".tupigcode", "skills", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return d;
}

describe("loadSkills 扫描与门禁禁①②", () => {
  it("合法技能解析 name/description（与内置包共存，用户在列）", () => {
    mkSkill("deploy", "name: deploy\ndescription: 一键部署到测试环境", "# 部署步骤\n...");
    const skills = loadSkills(dir);
    const deploy = skills.find((s) => s.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.description).toContain("部署");
    expect(skills.length).toBeGreaterThanOrEqual(9); // 用户 1 + 内置 ≥8（issue #19）
  });
  it("缺 description → 门禁拒绝（不入目录，内置不受影响）", () => {
    mkSkill("bad", "name: bad", "body");
    expect(loadSkills(dir).find((s) => s.name === "bad")).toBeUndefined();
    expect(loadSkills(dir).length).toBeGreaterThanOrEqual(8);
  });
  it("非 SKILL.md 目录忽略", () => {
    const d = path.join(dir, ".tupigcode", "skills", "nope");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "readme.md"), "x");
    expect(loadSkills(dir).find((s) => s.name === "nope")).toBeUndefined();
  });
  it("无用户 skills 目录 → 仅内置包", () => {
    const skills = loadSkills(dir);
    expect(skills.length).toBeGreaterThanOrEqual(8);
    expect(skills.every((s) => s.dir.includes("knowledge/skills"))).toBe(true);
  });
});

describe("formatSkillCatalog 披露预算（A12）", () => {
  const many = (n: number) => {
    for (let i = 0; i < n; i++) mkSkill(`s${i}`, `name: s${i}\ndescription: 技能${i} ${"详".repeat(120)}`, "b");
  };
  it("预算内全列 name+description", () => {
    mkSkill("a", "name: a\ndescription: 短描述", "b");
    const skills = loadSkills(dir);
    const text = formatSkillCatalog(skills);
    expect(text).toContain("a");
    expect(text).toContain("短描述");
    expect(text.length).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET);
  });
  it("超出预算 → 截断并计数提示", () => {
    many(50);
    const skills = loadSkills(dir);
    const text = formatSkillCatalog(skills);
    expect(text.length).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET);
    expect(text).toMatch(/其余 \d+ 个技能/);
  });
  it("空技能 → 空串", () => {
    expect(formatSkillCatalog([])).toBe("");
  });
});

describe("resolveSkill 三重门禁③ + 技能包", () => {
  it("合法加载：frontmatter+正文全文", () => {
    const d = mkSkill("deploy", "name: deploy\ndescription: 部署", "# 步骤\nrun tests");
    const r = resolveSkill(dir, "deploy");
    expect(r).not.toBeNull();
    expect(r!.body).toContain("run tests");
    expect(r!.path).toBe(path.join(d, "SKILL.md"));
  });
  it("门禁①：路径穿越名 → 拒绝", () => {
    mkSkill("x", "name: x\ndescription: d", "b");
    expect(resolveSkill(dir, "../.tupigcode/skills/x")).toBeNull();
    expect(resolveSkill(dir, "x/../../other")).toBeNull();
  });
  it("门禁③：超大文件 → 拒绝", () => {
    const d = mkSkill("big", "name: big\ndescription: d", "x".repeat(200_000));
    expect(resolveSkill(dir, "big")).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("不存在 → null", () => {
    expect(resolveSkill(dir, "nope")).toBeNull();
  });
});
