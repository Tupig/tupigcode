/**
 * E2 本地模型参数测试：30k 上下文 / 1800s 超时 / 默认模型 + TUPIG_MODEL 覆盖
 */
import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_TOKENS, API_FETCH_TIMEOUT_MS, DEFAULT_MODEL } from "../../src/engine/constants";
import { resolveModel } from "../../src/services/api";

describe("E2 模型参数", () => {
  it("上下文窗口为本地决议的 30k", () => {
    expect(MAX_CONTEXT_TOKENS).toBe(30_000);
  });
  it("API 超时 1800s（本地慢推理）", () => {
    expect(API_FETCH_TIMEOUT_MS).toBe(1_800_000);
  });
  it("默认模型为本地名而非云端 claude-*", () => {
    expect(DEFAULT_MODEL).toBe("14b");
    expect(DEFAULT_MODEL).not.toMatch(/^claude-/);
  });
  it("TUPIG_MODEL 覆盖默认", () => {
    expect(resolveModel({ TUPIG_MODEL: "8b" } as NodeJS.ProcessEnv)).toBe("8b");
  });
  it("无 TUPIG_MODEL 回落默认", () => {
    expect(resolveModel({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL);
  });
});
