/**
 * E59 截断续取交接提示（issue #56）
 *
 * - truncationHint：total/区间/续取参数，unit 条/字符
 * - Grep：offset 分页 + 截断 hint + 空页提示
 * - WebFetch：字符窗口 + 截断 hint（fetch stub 本地响应）
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { truncationHint } from "../../src/utils/truncationHint";
import { GrepTool } from "../../src/tools/Grep";
import { WebFetchTool } from "../../src/tools/Web";

let dir = "";
const ctx = () => ({ workDir: dir }) as any;
const noCanUse = (async () => ({ behavior: "allow" })) as any;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "tupig-e59-")); });
beforeEach(() => {
  const f = join(dir, "log.txt");
  writeFileSync(f, Array.from({ length: 5 }, (_, i) => `line${i + 1} match`).join("\n") + "\n");
});

describe("truncationHint", () => {
  it("条目单位：total/区间/续取参数齐全", () => {
    const h = truncationHint({ total: 250, shown: 100, offset: 0, limit: 100 });
    expect(h).toContain("total=250");
    expect(h).toContain("1~100");
    expect(h).toContain("offset=100");
    expect(h).toContain("head_limit=100");
  });

  it("字符单位 + 自定义参数名（WebFetch）", () => {
    const h = truncationHint({
      total: 30000, shown: 10000, offset: 0, limit: 10000,
      unit: "字符", offsetParam: "offset", limitParam: "maxLength",
    });
    expect(h).toContain("字符");
    expect(h).toContain("1~10000");
    expect(h).toContain("maxLength=10000");
  });

  it("分页中间页：区间从 offset+1 起", () => {
    const h = truncationHint({ total: 500, shown: 100, offset: 200, limit: 100 });
    expect(h).toContain("201~300");
    expect(h).toContain("offset=300");
  });
});

describe("Grep offset 分页", () => {
  it("head_limit=2 截断 → hint 带 total 与 offset=2", async () => {
    const r: any = await GrepTool.call(
      { pattern: "match", path: ".", head_limit: 2 },
      ctx(), noCanUse,
    );
    expect(r.data).toContain("line1");
    expect(r.data).toContain("line2");
    expect(r.data).not.toContain("line3");
    expect(r.data).toContain("total=5");
    expect(r.data).toContain("offset=2");
  }, 15_000);

  it("offset=2 → 第二页含 line3/4，无重复提示", async () => {
    const r: any = await GrepTool.call(
      { pattern: "match", path: ".", head_limit: 2, offset: 2 },
      ctx(), noCanUse,
    );
    expect(r.data).toContain("line3");
    expect(r.data).toContain("line4");
    expect(r.data).not.toContain("line1");
    expect(r.data).toContain("total=5");
  }, 15_000);

  it("offset 越界 → 空页提示含 total", async () => {
    const r: any = await GrepTool.call(
      { pattern: "match", path: ".", head_limit: 2, offset: 10 },
      ctx(), noCanUse,
    );
    expect(r.data).toContain("offset=10");
    expect(r.data).toContain("5");
  }, 15_000);

  it("不截断 → 无 hint", async () => {
    const r: any = await GrepTool.call(
      { pattern: "match", path: ".", head_limit: 50 },
      ctx(), noCanUse,
    );
    expect(r.data).toContain("line5");
    expect(r.data).not.toContain("已截断");
  }, 15_000);
});

describe("WebFetch offset 字符窗口", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function stubPage(text: string) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(text, {
      headers: { "content-type": "text/plain" },
    })));
  }

  it("超 maxLength → 头片 + 截断 hint（offset/maxLength）", async () => {
    await stubPage("A".repeat(500) + "B".repeat(500));
    const r: any = await (WebFetchTool as any).call({ url: "http://x.test/", maxLength: 400 });
    expect(r.data).toContain("A".repeat(400));
    expect(r.data).toContain("已截断");
    expect(r.data).toContain("total=1000");
    expect(r.data).toContain("offset=400");
    expect(r.data).toContain("maxLength=400");
  });

  it("offset=400 → 第二片，续取 hint 指向 offset=800", async () => {
    await stubPage("A".repeat(500) + "B".repeat(500));
    const r: any = await (WebFetchTool as any).call({ url: "http://x.test/", maxLength: 400, offset: 400 }, ctx());
    expect(r.data).toContain("B".repeat(300)); // 400~800 窗口：尾部 300 个 B
    expect(r.data).toContain("已截断"); // 800 < 1000，还有后续
    expect(r.data).toContain("offset=800");
  });

  it("内容不超限 → 原样返回", async () => {
    await stubPage("short page");
    const r: any = await (WebFetchTool as any).call({ url: "http://x.test/" });
    expect(r.data).toBe("short page");
  });
});
