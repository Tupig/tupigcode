/**
 * E23 内置技能包（issue #19）：可发现/加载 / 用户覆盖优先 / 预算不超 / frontmatter 门禁
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadSkills, resolveSkill, formatSkillCatalog,
  SKILL_CATALOG_BUDGET, MAX_SKILL_BYTES, BUILTIN_SKILLS_ROOT,
} from "../../src/knowledge/skills";

let dir: string;

function writeUserSkill(name: string, frontmatter: string, body: string): void {
  const d = path.join(dir, ".tupigcode", "skills", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("内置包可被发现/加载", () => {
  it("空工作区也能发现 ≥8 个内置技能", () => {
    const skills = loadSkills(dir);
    expect(skills.length).toBeGreaterThanOrEqual(8);
    const names = skills.map((s) => s.name);
    expect(names).toContain("git-workflow");
    expect(names).toContain("gitingest");
    expect(names).toContain("shell-command-engager");
  });

  it("resolveSkill 从内置目录加载完整正文", () => {
    const pkg = resolveSkill(dir, "git-log");
    expect(pkg).not.toBeNull();
    expect(pkg!.body.length).toBeGreaterThan(100);
    expect(pkg!.dir.startsWith(BUILTIN_SKILLS_ROOT)).toBe(true);
    expect(fs.existsSync(pkg!.path)).toBe(true);
  });
});

describe("用户覆盖优先", () => {
  it("同名用户技能覆盖内置（目录与正文都指向用户）", () => {
    writeUserSkill("gitingest", "name: gitingest\ndescription: 用户覆盖描述", "USER_BODY_MARKER");
    const listed = loadSkills(dir).find((s) => s.name === "gitingest");
    expect(listed!.description).toBe("用户覆盖描述");
    expect(listed!.dir.startsWith(dir)).toBe(true);

    const pkg = resolveSkill(dir, "gitingest");
    expect(pkg!.body).toContain("USER_BODY_MARKER");
  });

  it("用户无效技能（缺 description）被门禁挡，回落内置", () => {
    writeUserSkill("gitingest", "name: gitingest", "broken");
    const listed = loadSkills(dir).find((s) => s.name === "gitingest");
    expect(listed!.description).not.toBe("");
    expect(listed!.dir.startsWith(BUILTIN_SKILLS_ROOT)).toBe(true); // 内置兜底
    expect(resolveSkill(dir, "gitingest")!.body).not.toContain("broken");
  });

  it("无效且无内置同名 → 不入目录 / 不可加载", () => {
    writeUserSkill("broken-skill", "name: broken-skill", "缺描述");
    expect(loadSkills(dir).find((s) => s.name === "broken-skill")).toBeUndefined();
    expect(resolveSkill(dir, "broken-skill")).toBeNull();
  });
});

describe("目录预算与内置包门禁", () => {
  it("formatSkillCatalog 不超 SKILL_CATALOG_BUDGET（含固定头部余量）", () => {
    const catalog = formatSkillCatalog(loadSkills(dir));
    expect(catalog.length).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET + 200);
    expect(catalog).toContain("## 技能目录");
  });

  it("全部内置包通过三重门禁：frontmatter 完整 + 名同目录 + 体积达标", () => {
    const root = BUILTIN_SKILLS_ROOT;
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const e of entries) {
      const file = path.join(root, e.name, "SKILL.md");
      expect(fs.existsSync(file), `${e.name} 缺 SKILL.md`).toBe(true);
      const raw = fs.readFileSync(file, "utf-8");
      expect(raw.length, `${e.name} 超 MAX_SKILL_BYTES`).toBeLessThanOrEqual(MAX_SKILL_BYTES);
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(m, `${e.name} 缺 frontmatter`).not.toBeNull();
      const meta: Record<string, string> = {};
      for (const line of m![1].split("\n")) {
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
      }
      expect(meta.name, `${e.name} 缺 name`).toBeTruthy();
      expect(meta.description, `${e.name} 缺 description`).toBeTruthy();
      expect(meta.name, `${e.name} name 与目录不一致`).toBe(e.name);
    }
  });

  it("存在性：每个内置技能描述非空（可入目录）", () => {
    for (const s of loadSkills(dir)) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
    }
  });
});
