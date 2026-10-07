/**
 * E68 C 批深度审查（#53-#57）
 *
 * 审查点（C-1，#56）：续取参数非法值不得造成「空页 + hint 指示同 offset」死循环。
 *   全仓一贯模式是「非法/非正回退默认」（clipOutput budget、TUPIG_* resolve）：
 *   - Grep head_limit=0 靠 falsy 恰好回退，负数 truthy → slice 出空页
 *   - WebFetch maxLength=0/负 ?? 不拦截 → window 恒空、offset 永不前进
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { GrepTool } from "../../src/tools/Grep";
import { WebFetchTool } from "../../src/tools/Web";
import { MAX_GREP_RESULTS } from "../../src/engine/constants";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

const noCanUse = (async () => ({ behavior: "allow" })) as any;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tupig-e68-"));
  for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `f${i}.txt`), `match line ${i}\n`);
  return dir;
}

describe("审查点：续取参数非法值回退默认，不产空页死循环（C-1）", () => {
  it("Grep head_limit=0 → 回退默认页（非空）", async () => {
    const dir = makeDir();
    try {
      const r: any = await GrepTool.call(
        { pattern: "match", path: dir, head_limit: 0 } as any,
        { workDir: dir } as any,
        noCanUse,
      );
      const text = String(r.data ?? r);
      expect(text).not.toContain("找到 0 处匹配");
      expect(text.split("\n").filter((l: string) => l.includes("match line")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Grep head_limit=-5 → 同样回退默认（负数 truthy 不得 slice 出空页）", async () => {
    const dir = makeDir();
    try {
      const r: any = await GrepTool.call(
        { pattern: "match", path: dir, head_limit: -5 } as any,
        { workDir: dir } as any,
        noCanUse,
      );
      const text = String(r.data ?? r);
      expect(text).not.toContain("找到 0 处匹配");
      expect(text.split("\n").filter((l: string) => l.includes("match line")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Grep 非法 limit 的 hint 不带非正 limit（续取参数必须可前进）", async () => {
    const dir = makeDir();
    try {
      const r: any = await GrepTool.call(
        { pattern: "match", path: dir, head_limit: -5 } as any,
        { workDir: dir } as any,
        noCanUse,
      );
      const text = String(r.data ?? r);
      expect(text).not.toContain("head_limit=-5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WebFetch maxLength=0 → 回退默认窗口（不返回空 window 死循环）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello-e68 page", {
      headers: { "content-type": "text/plain" },
    })));
    try {
      const r: any = await (WebFetchTool as any).call({ url: "http://x.test/", maxLength: 0 });
      const text = String(r.data);
      expect(text.trim()).toBe("hello-e68 page"); // 整页回退默认窗口，非空 window
      expect(text).not.toContain("offset="); // 不产生原地续取 hint
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
