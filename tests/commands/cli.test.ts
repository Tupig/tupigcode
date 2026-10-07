/**
 * cli 启动器（bin TS 化）：共享设施与 llm 纯函数
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const { cliRoot, portListening } = await import("../../src/cli/common");
const { buildChatPayload, parseChatResponse } = await import("../../src/cli/llm");

describe("cliRoot", () => {
  it("指向仓库根（含 package.json）", () => {
    const root = cliRoot();
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "src", "cli", "common.ts"))).toBe(true);
  });
});

describe("portListening", () => {
  it("未监听端口返回 false", async () => {
    await expect(portListening(59999)).resolves.toBe(false);
  });
});

describe("llm chat 纯函数", () => {
  it("payload 结构与转义安全", () => {
    const p = JSON.parse(buildChatPayload('含"引号"与\n换行'));
    expect(p.model).toBe("default_model");
    expect(p.max_tokens).toBe(4096);
    expect(p.messages[0]).toEqual({ role: "user", content: '含"引号"与\n换行' });
  });

  it("解析正常响应", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "你好" } }] });
    expect(parseChatResponse(body)).toBe("你好");
  });

  it("choices 缺失返回空串", () => {
    expect(parseChatResponse("{}")).toBe("");
  });
});

describe("入口 shebang（bin 已消除，直接走 dist）", () => {
  it("6 个 src/cli 入口带 node shebang", () => {
    for (const n of ["tupigcode", "llm", "claude-local", "codex-local", "opencode-local", "mlx-local"]) {
      const body = readFileSync(join(cliRoot(), "src", "cli", `${n}.ts`), "utf-8");
      expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });

  it("bin/ 目录已移除", () => {
    expect(existsSync(join(cliRoot(), "bin"))).toBe(false);
  });

  it("package.json bin 指向 dist/cli", () => {
    const pkg = JSON.parse(readFileSync(join(cliRoot(), "package.json"), "utf-8"));
    expect(pkg.bin.tupigcode).toBe("dist/cli/tupigcode.js");
    expect(pkg.bin.llm).toBe("dist/cli/llm.js");
    expect(Object.keys(pkg.bin)).toHaveLength(7);
  });
});
