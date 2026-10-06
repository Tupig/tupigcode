/**
 * E26 repo-map 变更史注入（Context Lineage，issue #22）
 * 压缩摘要生成+缓存 / 注入预算截断 / 失败静默跳过 / 非 git 目录零变化
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { getLineage, capLineage, summarizeLineage, LINEAGE_CACHE_REL } from "../src/engine/lineage";
import type { ApiClient } from "../src/services/api";

const mockClient: ApiClient = { type: "mock" };


let repo = "";
let plain = "";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: "pipe",
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "lineage-repo-"));
  plain = mkdtempSync(join(tmpdir(), "lineage-plain-"));
  git("init -q", repo);
  git("config user.email t@t", repo);
  git("config user.name t", repo);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  git("add . && git commit -qm 'feat: 引入缓存层修复超时'", repo);
  writeFileSync(join(repo, "b.txt"), "v2\n");
  git("add . && git commit -qm 'fix: 修复压缩时的空指针'", repo);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

describe("压缩摘要生成 + 缓存", () => {
  it("生成摘要并落缓存（缓存含 HEAD hash）", async () => {
    const s = await getLineage(repo, mockClient, "mock-model");
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("摘要"); // mock 摘要标记
    const cacheFile = join(repo, LINEAGE_CACHE_REL);
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.head).toHaveLength(40);
    expect(cache.summary).toBe(s);
  });

  it("HEAD 未变 → 命中缓存，不调用模型", async () => {
    const before = await getLineage(repo, mockClient, "m");
    // 换一个必然抛错的 client：命中缓存则仍应返回原摘要
    const boom = { type: "unsupported" } as unknown as ApiClient;
    const after = await getLineage(repo, boom, "m");
    expect(after).toBe(before);
  });

  it("commit 变更 → 缓存失效；摘要失败时静默返回空", async () => {
    writeFileSync(join(repo, "c.txt"), "v3\n");
    git("add . && git commit -qm 'refactor: 拆分会话模块'", repo);
    const boom = { type: "unsupported" } as unknown as ApiClient;
    const out = await getLineage(repo, boom, "m");
    expect(out).toBe(""); // 静默跳过，不抛
  });

  it("summarizeLineage mock 链路可测", async () => {
    const s = await summarizeLineage(mockClient, "m", ["abc123 fix: 修了个 bug", "def456 feat: 加功能"]);
    expect(s).toContain("摘要");
    expect(s).toContain("2");
  });
});

describe("注入预算截断", () => {
  it("超预算取最近（尾部保留）", () => {
    const long = "x".repeat(500) + "RECENT_MARKER";
    const out = capLineage(long, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out).toContain("RECENT_MARKER");
  });

  it("未超预算原样返回", () => {
    expect(capLineage("short", 100)).toBe("short");
  });
});

describe("失败静默跳过 / 非 git 目录零变化", () => {
  it("非 git 目录返回空、不抛、不写缓存", async () => {
    const out = await getLineage(plain, mockClient, "m");
    expect(out).toBe("");
    expect(existsSync(join(plain, LINEAGE_CACHE_REL))).toBe(false);
  });

  it("不存在的目录也静默", async () => {
    const out = await getLineage(join(plain, "nope"), mockClient, "m");
    expect(out).toBe("");
  });
});
