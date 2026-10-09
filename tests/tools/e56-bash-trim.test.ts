/**
 * E56 Bash 输出 head+tail 裁剪可配（issue #53）
 *
 * - clipOutput：both 双端保留 / head 保头 / tail 保尾，截断标注原始大小与省略量
 * - 预算内原样返回不截断
 * - resolveBashOutputBudget：TUPIG_BASH_OUTPUT_CHARS 覆盖、非法回退默认
 * - Bash 工具集成：keep 参数生效、env 预算生效
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { clipOutput, resolveBashOutputBudget } from "../../src/utils/clip-output";
import { MAX_BASH_OUTPUT_CHARS } from "../../src/engine/constants";
import { BashTool } from "../../src/tools/Bash";

let workDir = "";
beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), "tupig-e56-")); });
afterAll(() => { delete process.env.TUPIG_BASH_OUTPUT_CHARS; });

describe("clipOutput", () => {
  const head = "HEAD".repeat(40);   // 160
  const mid = "MID".repeat(400);    // 1200
  const tail = "TAIL".repeat(40);   // 160
  const text = head + mid + tail;   // 1520

  it("both：双端保留 + 截断标注（原始大小/省略量/keep）", () => {
    const r = clipOutput(text, "both", 400);
    expect(r.clipped).toBe(true);
    expect(r.originalLength).toBe(1520);
    expect(r.omittedLength).toBeGreaterThan(0);
    expect(r.text).toContain("HEAD");   // 头部在
    expect(r.text).toContain("TAIL");   // 尾部在
    // 中段大幅丢弃（头部分割处可带入少量 MID）
    expect((r.text.match(/MID/g) ?? []).length).toBeLessThan(100);
    expect(r.text).toContain("已截断");
    expect(r.text).toContain("1520");
    expect(r.text).toContain("keep=both");
  });

  it("head：只保头（旧语义）", () => {
    const r = clipOutput(text, "head", 400);
    expect(r.clipped).toBe(true);
    expect(r.text).toContain("HEAD");
    expect(r.text).not.toContain("TAILTAILTAIL");
    expect(r.text).toContain("keep=head");
  });

  it("tail：只保尾", () => {
    const r = clipOutput(text, "tail", 400);
    expect(r.clipped).toBe(true);
    expect(r.text).toContain("TAIL");
    expect(r.text).not.toContain("HEADHEADHEAD");
    expect(r.text).toContain("keep=tail");
  });

  it("预算内原样返回不截断", () => {
    const r = clipOutput("short output", "both", 400);
    expect(r.clipped).toBe(false);
    expect(r.text).toBe("short output");
    expect(r.omittedLength).toBe(0);
  });

  it("both 分配：head 60% + tail 40%（约）", () => {
    const r = clipOutput(text, "both", 100);
    const kept = r.text.slice(0, r.text.indexOf("\n…"));
    // 保留主体 ≤100 字符（标注行除外）
    expect(kept.length).toBeLessThanOrEqual(100);
    expect(r.clipped).toBe(true);
  });
});

describe("resolveBashOutputBudget", () => {
  it("默认 = MAX_BASH_OUTPUT_CHARS", () => {
    delete process.env.TUPIG_BASH_OUTPUT_CHARS;
    expect(resolveBashOutputBudget()).toBe(MAX_BASH_OUTPUT_CHARS);
  });

  it("合法 env 覆盖", () => {
    process.env.TUPIG_BASH_OUTPUT_CHARS = "1234";
    expect(resolveBashOutputBudget()).toBe(1234);
    delete process.env.TUPIG_BASH_OUTPUT_CHARS;
  });

  it("非法/0/负数回退默认", () => {
    for (const v of ["abc", "0", "-5", "NaN"]) {
      process.env.TUPIG_BASH_OUTPUT_CHARS = v;
      expect(resolveBashOutputBudget()).toBe(MAX_BASH_OUTPUT_CHARS);
    }
    delete process.env.TUPIG_BASH_OUTPUT_CHARS;
  });
});

describe("Bash 工具集成", () => {
  it("长输出 both：首尾行都在 + 截断标注", async () => {
    process.env.TUPIG_BASH_OUTPUT_CHARS = "300";
    try {
      const r: any = await (BashTool as any).call(
        { command: "seq 1 500", keep: "both" },
        { workDir },
      );
      expect(r.data).toContain("1\n");
      expect(r.data).toContain("500");
      expect(r.data).toContain("已截断");
      expect(r.data).toContain("原始"); // 截断标注含原始大小
      expect(r.data.length).toBeLessThan(600);
    } finally {
      delete process.env.TUPIG_BASH_OUTPUT_CHARS;
    }
  }, 15_000);

  it("keep=head：无尾部行", async () => {
    process.env.TUPIG_BASH_OUTPUT_CHARS = "300";
    try {
      const r: any = await (BashTool as any).call(
        { command: "seq 1 500", keep: "head" },
        { workDir },
      );
      expect(r.data).toContain("1\n");
      expect(r.data).not.toContain("\n500\n");
      expect(r.data).toContain("keep=head");
    } finally {
      delete process.env.TUPIG_BASH_OUTPUT_CHARS;
    }
  }, 15_000);

  it("短输出不截断原样返回", async () => {
    const r: any = await (BashTool as any).call({ command: "echo hello-clip" }, { workDir });
    expect(r.data).toContain("hello-clip");
    expect(r.data).not.toContain("已截断");
  }, 15_000);
});
