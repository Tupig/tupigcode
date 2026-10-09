/**
 * e82: F 批低风险清理清单（issue #92）
 *
 * 覆盖：extractFailures 数组形态、审批粘贴首行解析、skills 超长 description 截断、
 * autoSnapshot 防抖原子（并发只建一个）、sessionState 降级接线、plan spec workDir 基线。
 * （config.json 保护经确认为 #12 契约，保留不删）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

describe("extractFailures 数组形态（issue #92）", () => {
  it("Anthropic content blocks 数组的 tool_result 也抽得到", async () => {
    const { extractFailures } = await import("../../src/knowledge/reflexion");
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", is_error: true, content: [{ type: "text", text: "boom-array" }] },
        ],
      },
      { role: "user", content: [{ type: "tool_result", is_error: true, content: "boom-string" }] },
      { role: "user", content: [{ type: "tool_result", is_error: false, content: "ok" }] },
    ];
    const out = extractFailures(messages);
    expect(out).toContain("boom-array");
    expect(out).toContain("boom-string");
    expect(out.some((f) => f === "ok")).toBe(false);
  });
});

describe("审批粘贴首行解析（issue #92）", () => {
  it("y⏎后带杂散行 → 取首行判定 y", async () => {
    const { parseApprovalAnswer } = await import("../../src/services/permissions");
    expect(parseApprovalAnswer("y\nextra junk\n")).toBe("y");
    expect(parseApprovalAnswer("a")).toBe("a");
    expect(parseApprovalAnswer("yes\n")).toBe("yes");
    expect(parseApprovalAnswer("n\ny")).toBe("n"); // 首行决定
    expect(parseApprovalAnswer("  Y  \n")).toBe("y");
  });
});

describe("skills 超长 description 截断（issue #92）", () => {
  it("单条超长受目录预算约束（展示首条+计数）", async () => {
    const { formatSkillCatalog } = await import("../../src/knowledge/skills");
    const huge = "D".repeat(5000);
    const catalog = formatSkillCatalog([
      { name: "alpha", description: huge, dir: "/x/alpha" },
      { name: "beta", description: "短描述", dir: "/x/beta" },
    ]);
    expect(catalog).toContain("alpha");
    expect(catalog).toContain("beta"); // 修前：首条超预算 break → 0 展示
    expect(catalog).not.toContain("D".repeat(300)); // 截断生效
  });
});

describe("autoSnapshot 并发防抖（issue #92）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tupig-e82-"));
    execSync("git init -q", { cwd: dir });
    execSync("git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: dir });
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "v1", "utf-8");
    process.env.TUPIG_AUTOSNAPSHOT = "0";
  });
  afterEach(() => {
    delete process.env.TUPIG_AUTOSNAPSHOT;
    rmSync(dir, { recursive: true, force: true });
  });

  it("两次并发 autoSnapshot 只建一个检查点", async () => {
    const { autoSnapshot, listCheckpoints } = await import("../../src/session/checkpoint");
    const [r1, r2] = await Promise.all([
      autoSnapshot(dir, "concurrent-a", [], 60_000),
      autoSnapshot(dir, "concurrent-b", [], 60_000),
    ]);
    const created = [r1, r2].filter(Boolean);
    expect(created).toHaveLength(1);
    const recs = await listCheckpoints(dir);
    expect(recs).toHaveLength(1);
  });
});

describe("sessionState 降级接线（issue #92）", () => {
  it("sessionState.ts 不导出 loadSession/listSessions", async () => {
    const mod = await import("../../src/session/session-state");
    expect(mod.loadSession).toBeUndefined();
    expect(mod.listSessions).toBeUndefined();
    expect(typeof mod.generateSessionId).toBe("function");
    expect(typeof mod.createSessionState).toBe("function");
  });

  it("QueryEngine 不引用 loadSession", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "engine", "QueryEngine.ts"), "utf-8");
    expect(src).not.toMatch(/loadSession/);
    expect(src).toMatch(/createSessionState\(config\.sessionId \?\? generateSessionId\(\)\)/);
  });

  it("SessionState 仅保留活字段 sessionId", async () => {
    const st = await import("../../src/session/session-state");
    const s = st.createSessionState("s-only");
    expect(s.sessionId).toBe("s-only");
    expect(Object.keys(s)).toEqual(["sessionId"]);
  });
});

describe("plan spec workDir 基线（issue #92）", () => {
  it("permissions.ts spec 判定以 workDir 为基线（非 cwd）", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "services", "permissions.ts"), "utf-8");
    expect(src).toMatch(/resolve\(workDir, artifact\)\.includes\("\/\.tupigcode\/specs\/"\)/);
  });
});
