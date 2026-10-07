/**
 * E24 hook 信任持久化 TOFU（issue #20）：首次询问后续放行 / 规则变更重询 /
 * 异常 fail-closed 不受影响 / 信任清单与清除
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hashRule, isTrusted, recordTrusted, clearTrust, listTrust,
  ensureHookTrust, answerHookTrust, TRUST_FILE,
} from "../../src/engine/hookTrust";
import { interpretShellExit, type ShellHookConfig } from "../../src/engine/hooks";
import { runDoctor } from "../../src/commands/diag";

let dir: string;
const hook: ShellHookConfig = { event: "PreToolUse", command: "echo guard" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-trust-"));
  delete process.env.TUPIG_HOOK_TRUST;
});
afterEach(() => {
  delete process.env.TUPIG_HOOK_TRUST;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("首次询问后续放行（TOFU）", () => {
  it("未信任 + 可询问 → ask；确认后 → run（且持久化重读仍 run）", async () => {
    expect(await ensureHookTrust(dir, hook, { canPrompt: true })).toBe("ask");
    expect(answerHookTrust(dir, hook, true)).toBe("run");
    expect(isTrusted(dir, hook)).toBe(true);
    expect(await ensureHookTrust(dir, hook, { canPrompt: true })).toBe("run");
    // 持久化：信任文件存在且可重读
    expect(fs.existsSync(path.join(dir, TRUST_FILE))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, TRUST_FILE), "utf-8"));
    expect(Object.keys(raw).length).toBe(1);
  });

  it("拒绝（no）→ deny 且不持久化 → 下次仍需询问", async () => {
    expect(answerHookTrust(dir, hook, false)).toBe("deny");
    expect(isTrusted(dir, hook)).toBe(false);
    expect(await ensureHookTrust(dir, hook, { canPrompt: true })).toBe("ask");
  });

  it("不可询问（非 TTY/CI）→ 直接 run（配置即显式意图）", async () => {
    expect(await ensureHookTrust(dir, hook, { canPrompt: false })).toBe("run");
    expect(isTrusted(dir, hook)).toBe(false); // 不落信任记录
  });

  it("TUPIG_HOOK_TRUST=0 → 永远 run（显式关闭信任询问）", async () => {
    process.env.TUPIG_HOOK_TRUST = "0";
    expect(await ensureHookTrust(dir, hook, { canPrompt: true })).toBe("run");
  });
});

describe("规则变更重询", () => {
  it("同 command 不同规则（timeout/matcher）hash 不同 → 重新 ask", async () => {
    recordTrusted(dir, hook);
    const changed: ShellHookConfig = { ...hook, timeout: 9999 };
    expect(hashRule(changed)).not.toBe(hashRule(hook));
    expect(await ensureHookTrust(dir, changed, { canPrompt: true })).toBe("ask");
    const matched: ShellHookConfig = { ...hook, matcher: { tool_name: "Edit" } };
    expect(await ensureHookTrust(dir, matched, { canPrompt: true })).toBe("ask");
  });

  it("hash 稳定：同规则重复计算一致", () => {
    expect(hashRule(hook)).toBe(hashRule({ ...hook }));
  });
});

describe("异常 fail-closed 不受影响", () => {
  it("超时 → block（TOFU 不豁免）", () => {
    expect(interpretShellExit(null, "", "", false).block).toBe(true);
  });
  it("非零退出 → block + 消息", () => {
    const r = interpretShellExit(3, "", "bad rule", false);
    expect(r.block).toBe(true);
    expect(r.message).toContain("bad rule");
  });
});

describe("信任清单与清除", () => {
  it("listTrust 含 command/trustedAt；clearTrust 后重询", async () => {
    answerHookTrust(dir, hook, true);
    const list = listTrust(dir);
    expect(list).toHaveLength(1);
    expect(list[0].command).toBe("echo guard");
    expect(list[0].trustedAt).toBeTruthy();

    clearTrust(dir);
    expect(listTrust(dir)).toHaveLength(0);
    expect(await ensureHookTrust(dir, hook, { canPrompt: true })).toBe("ask");
  });

  it("/doctor 可见信任清单（hook-trust 条目）", () => {
    answerHookTrust(dir, hook, true);
    const r = runDoctor(dir);
    const entry = r.find((x) => x.id === "hook-trust");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("ok");
    expect(entry!.detail).toContain("echo guard");
  });
});
