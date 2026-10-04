/**
 * E70 issue 清理批次 1（#66 / #72 / #77）
 *
 * 审查点 1（#66）：mapWithConcurrency 的 limit<1 是配置错误，必须同步显式抛出，
 *   不得静默抬成 1 或静默不执行。
 * 审查点 2（#72）：MultiEdit 审批 ask 必须渲染真实变更 diff（与 Edit/Write 同级
 *   信息量）；任一处不匹配 → null 回退 JSON 截断。
 * 审查点 3（#77）：OAuth 授权必须携带 state，回调 state 不匹配的 code 一律拒绝
 *   （防本机任意页面注入授权码）。
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { mapWithConcurrency } from "../src/tools/parallel";
import { buildApprovalPreview } from "../src/services/permissions";
import { FileOAuthProvider } from "../src/engine/mcp";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("审查点 1：limit<1 同步抛出（#66）", () => {
  it("limit=0 → 抛 RangeError，fn 零执行", async () => {
    const ran: number[] = [];
    let thrown: unknown = null;
    try {
      await mapWithConcurrency([1, 2], 0, async (n) => {
        ran.push(n);
        return n;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect(ran).toHaveLength(0);
  });

  it("limit=-1 同样抛出", async () => {
    await expect(
      mapWithConcurrency([1], -1, async (n) => n),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("limit=1 正常执行（合法下界）", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => n * 2);
    expect(out.map((r: any) => r.value)).toEqual([2, 4, 6]);
  });
});

describe("审查点 2：MultiEdit 审批 diff 预览（#72）", () => {
  function mkFile(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e70-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    const fp = join(dir, "a.txt");
    writeFileSync(fp, lines.join("\n") + "\n");
    return fp;
  }

  it("两处替换 → 渲染含旧/新行的 diff，与逐序 previewEdit 结果一致", async () => {
    const fp = mkFile(["alpha", "beta", "gamma"]);
    try {
      const preview = await buildApprovalPreview("MultiEdit", {
        file_path: fp,
        edits: [
          { old_string: "alpha", new_string: "ALPHA-1" },
          { old_string: "gamma", new_string: "GAMMA-3" },
        ],
      });
      expect(preview).toBeTruthy();
      expect(preview).toContain("+");
      expect(preview).toContain("-");
      expect(preview).toContain("ALPHA-1");
      expect(preview).toContain("GAMMA-3");
      expect(preview).not.toContain("old_string"); // 不是 JSON 回退
    } finally {
      rmSync(dirnameOf(fp), { recursive: true, force: true });
    }
  });

  it("第二处不匹配 → null（回退 JSON 截断）", async () => {
    const fp = mkFile(["alpha", "beta"]);
    try {
      const preview = await buildApprovalPreview("MultiEdit", {
        file_path: fp,
        edits: [
          { old_string: "alpha", new_string: "A" },
          { old_string: "NOT-EXIST", new_string: "x" },
        ],
      });
      expect(preview).toBeNull();
    } finally {
      rmSync(dirnameOf(fp), { recursive: true, force: true });
    }
  });

  it("文件不存在 → null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e70x-"));
    try {
      const preview = await buildApprovalPreview("MultiEdit", {
        file_path: join(dir, "missing.txt"),
        edits: [{ old_string: "a", new_string: "b" }],
      });
      expect(preview).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("审查点 3：OAuth state 校验（#77）", () => {
  it("redirectToAuthorization 拼入 state，与 provider 存储一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e70o-"));
    try {
      const p = new FileOAuthProvider("https://srv.example/mcp", {
        dir,
        open: () => {},
      });
      await p.whenReady;
      const authUrl = new URL("https://as.example/authorize?client_id=c&redirect_uri=r");
      p.redirectToAuthorization(authUrl);
      const state = authUrl.searchParams.get("state");
      expect(state).toBeTruthy();
      expect((p as any).oauthState).toBe(state);
      p.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("回调 state 匹配 → 收下 code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e70o2-"));
    try {
      const p = new FileOAuthProvider("https://srv2.example/mcp", { dir, open: () => {} });
      await p.whenReady;
      const codes: string[] = [];
      p.onCode = (c) => codes.push(c);
      const authUrl = new URL("https://as.example/authorize");
      p.redirectToAuthorization(authUrl);
      const state = authUrl.searchParams.get("state")!;
      // 直接触发回调 handler 路径（模拟浏览器 GET）
      await hitCallback(p, `?code=good&state=${encodeURIComponent(state)}`);
      expect(codes).toEqual(["good"]);
      p.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("回调 state 不匹配 / 缺失 → 拒绝 code，onCode 不触发", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e70o3-"));
    try {
      const p = new FileOAuthProvider("https://srv3.example/mcp", { dir, open: () => {} });
      await p.whenReady;
      const codes: string[] = [];
      p.onCode = (c) => codes.push(c);
      const authUrl = new URL("https://as.example/authorize");
      p.redirectToAuthorization(authUrl);
      await hitCallback(p, "?code=evil&state=WRONG");
      expect(codes).toHaveLength(0);
      await hitCallback(p, "?code=evil2"); // 无 state
      expect(codes).toHaveLength(0);
      p.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 直接触发 provider 内部回调监听（经真实 HTTP 回环） */
async function hitCallback(p: FileOAuthProvider, search: string): Promise<void> {
  const redirect = new URL(String(p.redirectUrl));
  const res = await fetch(`http://127.0.0.1:${redirect.port}/callback${search}`);
  await res.text();
}

function dirnameOf(fp: string): string {
  return fp.slice(0, fp.lastIndexOf("/"));
}
