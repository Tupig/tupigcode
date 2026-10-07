/**
 * E73 死常量接线一致性（#84，方案 a 等值接线）
 *
 * 审查点：三个常量（HOOK_TIMEOUT_MS / MAX_RESULT_CHARS / TOKEN_BYTES_PER_TOKEN）
 * 是唯一事实源，所有使用点必须引用常量而非字面量，防止改常量不生效。
 * 等值替换下行为不变，故用源码结构断言锁定接线形态。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("死常量接线（#84）", () => {
  it("constants.ts 导出三常量（唯一事实源）", async () => {
    const c = await import("../../src/engine/constants");
    expect(c.HOOK_TIMEOUT_MS).toBe(5_000);
    expect(c.MAX_RESULT_CHARS).toBe(100_000);
    expect(c.TOKEN_BYTES_PER_TOKEN).toBe(4);
  });

  it("hooks 超时默认值引用 HOOK_TIMEOUT_MS，无字面量 5000", () => {
    const src = read("src/engine/hooks.ts");
    expect(src).toMatch(/timeoutMs\s*=\s*HOOK_TIMEOUT_MS/);
    expect(src).not.toMatch(/timeoutMs\s*=\s*5000/);
  });

  it("写/读工具结果上限引用 MAX_RESULT_CHARS，无字面量 100_000", () => {
    for (const f of ["FileWrite.ts", "MultiEdit.ts", "FileEdit.ts", "DocRead.ts"]) {
      const src = read(`src/tools/${f}`);
      expect(src, f).toMatch(/MAX_RESULT_CHARS/);
      expect(src, f).not.toMatch(/100_000/);
    }
  });

  it("estimateTokens 系数引用 TOKEN_BYTES_PER_TOKEN，无内联 4", () => {
    const src = read("src/context/compact/index.ts");
    expect(src).toMatch(/\/\s*TOKEN_BYTES_PER_TOKEN/);
    expect(src).not.toMatch(/\.length\s*\/\s*4\b/);
  });
});
