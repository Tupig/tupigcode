/**
 * N9 repo 地图与搜索限量（A18）：符号索引 + token 预算 + 缓存 + 超量降级
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { extractSymbols, buildRepoMap, REPO_SKIP_DIRS, REPO_MAP_BUDGET } =
  await import("../../src/context/repomap");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n9-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("extractSymbols", () => {
  it("TS：函数/类/接口/类型/枚举/导出常量", () => {
    const code = [
      "export function alpha(a: number) {",
      "  return a;",
      "}",
      "export class Beta {",
      "  run() {}",
      "}",
      "export interface Gamma {",
      "  x: number;",
      "}",
      "export type Delta = string;",
      "export enum Eps { A, B }",
      "export const ZETA = 1;",
      "const NOT_EXPORTED = 2;",
      "// function Commented() {}",
      "function plain() {}",
    ].join("\n");
    const syms = extractSymbols(code, "a.ts");
    const names = syms.map((s) => s.name);
    for (const n of ["alpha", "Beta", "Gamma", "Delta", "Eps", "ZETA", "plain"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("Commented");
    expect(syms.find((s) => s.name === "alpha")).toMatchObject({ kind: "function", line: 1 });
    expect(syms.find((s) => s.name === "Beta")?.kind).toBe("class");
    expect(syms.find((s) => s.name === "ZETA")?.kind).toBe("const");
    expect(syms.find((s) => s.name === "plain")?.kind).toBe("function");
  });

  it("Python 与 Go", () => {
    const py = extractSymbols("def go(a):\n    pass\nclass K:\n    pass\n", "a.py");
    expect(py.map((s) => s.name)).toEqual(["go", "K"]);
    expect(py[0]).toMatchObject({ kind: "function", line: 1 });

    const go = extractSymbols(
      "func (r *Repo) Build() {}\ntype Node struct {\n\tName string\n}\n",
      "a.go",
    );
    expect(go.map((s) => s.name)).toEqual(["Build", "Node"]);
    expect(go[0].kind).toBe("function");
    expect(go[1].kind).toBe("type");
  });

  it("行号 1-based 且空输入安全", () => {
    expect(extractSymbols("", "x.ts")).toEqual([]);
    const s = extractSymbols("\nconst A = 1;", "x.ts");
    expect(s[0].line).toBe(2);
  });
});

describe("buildRepoMap", () => {
  it("输出 path:line 符号清单", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export function hello() {}\nexport class Svc {}\n");
    const out = buildRepoMap(dir);
    expect(out.text).toContain("src/a.ts:1");
    expect(out.text).toContain("hello");
    expect(out.text).toContain("Svc");
    expect(out.symbols).toBe(2);
  });

  it("跳过 node_modules/.git/dist 等目录", () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "i.js"), "function hidden() {}");
    writeFileSync(join(dir, ".git", "hooks.js"), "function gitHook() {}");
    writeFileSync(join(dir, "dist", "out.js"), "function built() {}");
    writeFileSync(join(dir, "keep.ts"), "function visible() {}");
    const out = buildRepoMap(dir);
    expect(out.text).toContain("visible");
    expect(out.text).not.toContain("hidden");
    expect(out.text).not.toContain("gitHook");
    expect(out.text).not.toContain("built");
    expect(REPO_SKIP_DIRS).toContain("node_modules");
  });

  it("预算截断并提示总数", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(dir, "src", `f${i}.ts`), `export function fn${i}() {}\n`);
    }
    const out = buildRepoMap(dir, { budget: 300 });
    expect(out.text.length).toBeLessThan(600);
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/截断|省略/);
  });

  it("空仓库返回提示", () => {
    const out = buildRepoMap(dir);
    expect(out.symbols).toBe(0);
    expect(out.text).toMatch(/无可索引|空/);
  });

  it("缓存落盘且 mtime 未变时命中", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export function cached() {}\n");
    buildRepoMap(dir);
    expect(existsSync(join(dir, ".tupigcode", "cache", "repomap.json"))).toBe(true);

    // 未变更 → 命中缓存（不重读文件）
    const first = buildRepoMap(dir);
    expect(first.fromCache).toBe(true);
    const second = buildRepoMap(dir);
    expect(second.text).toBe(first.text);
  });

  it("mtime 变化触发重建", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export function one() {}\n");
    buildRepoMap(dir);
    writeFileSync(join(dir, "src", "a.ts"), "export function two() {}\n");
    const out = buildRepoMap(dir);
    expect(out.text).toContain("two");
  });

  it("默认预算非零", () => {
    expect(REPO_MAP_BUDGET).toBeGreaterThan(500);
  });
});

describe("Grep 超量降级（SWE-agent：只列文件名）", () => {
  it("匹配行超 head_limit 且散在多文件时只列文件", async () => {
    const sub = join(dir, "hits");
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(sub, `f${i}.ts`), `// hit\nclass Hit${i} {}\nclass Hit${i}B {}\n`);
    }
    const { GrepTool } = await import("../../src/tools/Grep");
    const ctx = {
      options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
      abortController: new AbortController(),
      readFileState: new Map(),
      getMessages: () => [],
      workDir: dir,
      sessionId: "s",
    } as any;
    const allow = async () => ({ behavior: "allow" as const });
    const r = await GrepTool.call({ pattern: "class Hit", path: ".", head_limit: 3 }, ctx, allow);
    expect(String(r.data)).toMatch(/文件/);
    expect(String(r.data)).not.toContain("class Hit5");
  }, 20_000);
});

describe("RepoMap 工具", () => {
  it("只读、schema 齐全、call 返回清单", async () => {
    const { RepoMapTool } = await import("../../src/tools/RepoMap");
    expect(RepoMapTool.isReadOnly({})).toBe(true);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export function toolOk() {}\n");
    const ctx = {
      options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
      abortController: new AbortController(),
      readFileState: new Map(),
      getMessages: () => [],
      workDir: dir,
      sessionId: "s",
    } as any;
    const r = await RepoMapTool.call({ budget: 2000 }, ctx, async () => ({ behavior: "allow" as const }));
    expect(String(r.data)).toContain("toolOk");
  });
});
