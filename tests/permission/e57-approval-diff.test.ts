/**
 * E57 审批 ask 时 diff 预览（issue #54）
 *
 * - renderOpsPreview：modify/create 渲染、空/异常 null
 * - previewEdit：精确/replace_all/模糊单命中，多处或不匹配 null
 * - buildApprovalPreview：Edit/Write 真实 diff，其他工具/失败回退 null
 * - promptUserDecision 弹问打印含 diff 行（console.log 捕获）
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { renderOpsPreview } from "../../src/engine/diffReview";
import { previewEdit } from "../../src/tools/FileEdit";
import { buildApprovalPreview, promptUserDecision } from "../../src/services/permissions";
import { appStore } from "../../src/state/AppState";
import { hookSystem } from "../../src/engine/hooks";

let dir = "";
beforeAll(() => { process.env.TUPIG_MOCK = "1"; });
afterAll(() => { hookSystem.clear(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tupig-e57-"));
  appStore.setState((s) => ({ ...s, workDir: dir }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("renderOpsPreview", () => {
  it("modify：文件头 + hunk 行（- 旧 / + 新）", () => {
    const out = renderOpsPreview([{ path: "/w/a.ts", before: "a\nb\nc", after: "a\nB\nc" }]);
    expect(out).toContain("--- /w/a.ts");
    expect(out).toContain("修改");
    expect(out).toContain("-b");
    expect(out).toContain("+B");
  });

  it("create（before=null）：标注新建", () => {
    const out = renderOpsPreview([{ path: "/w/new.ts", before: null, after: "hello\nworld" }]);
    expect(out).toContain("新建");
    expect(out).toContain("+hello");
  });

  it("空 ops → null；同文件多 op 合并", () => {
    expect(renderOpsPreview([])).toBeNull();
    const out = renderOpsPreview([
      { path: "/w/a.ts", before: "x", after: "y" },
      { path: "/w/a.ts", before: "y", after: "z" },
    ]);
    expect(out).toContain("-x");
    expect(out).toContain("+z");
  });
});

describe("previewEdit（与 call 同源定位）", () => {
  const content = "line1\nline2\nline3";

  it("精确单命中 → 替换后内容", () => {
    const out = previewEdit(content, { old_string: "line2", new_string: "LINE2" });
    expect(out).toBe("line1\nLINE2\nline3");
  });

  it("replace_all → 全部替换", () => {
    const out = previewEdit("a-b-a", { old_string: "a", new_string: "X", replace_all: true });
    expect(out).toBe("X-b-X");
  });

  it("多处匹配且未 replace_all → null", () => {
    expect(previewEdit("a a a", { old_string: "a", new_string: "X" })).toBeNull();
  });

  it("不匹配 → null", () => {
    expect(previewEdit("abc", { old_string: "zzz", new_string: "X" })).toBeNull();
  });

  it("模糊单命中（缩进差异）→ 替换", () => {
    const out = previewEdit("if (x) {\n    foo();\n}", {
      old_string: "if (x) {\n  foo();\n}",
      new_string: "if (x) {\n  bar();\n}",
    });
    expect(out).toContain("bar();");
    expect(out).not.toContain("foo();");
  });
});

describe("buildApprovalPreview", () => {
  it("Write 新文件 → create diff", async () => {
    const out = await buildApprovalPreview("Write", { file_path: "src/new.ts", content: "export const n = 1;\n" });
    expect(out).toBeTruthy();
    expect(out!).toContain("新建");
    expect(out!).toContain("+export const n = 1;");
  });

  it("Write 覆盖已有 → modify diff", async () => {
    writeFileSync(join(dir, "a.ts"), "old line\nkeep\n");
    const out = await buildApprovalPreview("Write", { file_path: "a.ts", content: "new line\nkeep\n" });
    expect(out!).toContain("-old line");
    expect(out!).toContain("+new line");
  });

  it("Edit 精确命中 → diff", async () => {
    writeFileSync(join(dir, "b.ts"), "alpha\nbeta\n");
    const out = await buildApprovalPreview("Edit", {
      file_path: "b.ts", old_string: "beta", new_string: "BETA",
    });
    expect(out!).toContain("-beta");
    expect(out!).toContain("+BETA");
  });

  it("Edit 不匹配 → null（回退 JSON）", async () => {
    writeFileSync(join(dir, "c.ts"), "content\n");
    const out = await buildApprovalPreview("Edit", {
      file_path: "c.ts", old_string: "missing", new_string: "x",
    });
    expect(out).toBeNull();
  });

  it("非写工具 / 缺 file_path → null", async () => {
    expect(await buildApprovalPreview("Bash", { command: "ls" })).toBeNull();
    expect(await buildApprovalPreview("Write", { content: "z" })).toBeNull();
  });

  it("内容相同 → null（无可审变更）", async () => {
    writeFileSync(join(dir, "same.ts"), "same\n");
    const out = await buildApprovalPreview("Write", { file_path: "same.ts", content: "same\n" });
    expect(out).toBeNull();
  });
});

describe("promptUserDecision 打印 diff", () => {
  it("TTY 审批 Write → console.log 含 diff 行", async () => {
    writeFileSync(join(dir, "d.ts"), "before-yes\n");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });

    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const p = promptUserDecision("Write", { file_path: "d.ts", content: "after-no\n" });
      await new Promise((r) => setTimeout(r, 30));
      expect(logs.join("\n")).toContain("---");
      expect(logs.join("\n")).toContain("+after-no");
      process.stdin.emit("data", "n\n");
      expect(await p).toBe("deny");
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as any).isTTY;
    }
  }, 10_000);

  it("TTY 审批 Bash → 仍回退 JSON 截断打印", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });

    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const p = promptUserDecision("Bash", { command: "rm -rf /tmp/x" });
      await new Promise((r) => setTimeout(r, 30));
      expect(logs.join("\n")).toContain("rm -rf");
      process.stdin.emit("data", "n\n");
      await p;
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as any).isTTY;
    }
  }, 10_000);
});
