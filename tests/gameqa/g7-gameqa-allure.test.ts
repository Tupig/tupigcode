/**
 * G7 Allure 风格富报告：四 tab（Overview/Suites/Categories/用例详情）+ 历史切换。对应 issue #9。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";
import { renderAllureHtml } from "../../src/gameqa/allure";

type Case = Record<string, unknown>;

function mkCase(fullname: string, result: string, extra: Record<string, unknown> = {}): Case {
  const [classname, ...rest] = fullname.split(".");
  return {
    fullname,
    name: rest.join(".") || fullname,
    classname,
    result,
    duration: 0.1,
    message: null,
    stack: null,
    stdout: null,
    ...extra,
  };
}

function jobWithCases(id: number, ts: number) {
  return {
    job_id: id, platform: "mac", status: "failed", created_at: ts,
    extra: { job_type: "generate_and_run" },
    result: {
      success: false,
      summary: {
        total: 3, passed: 2, failed: 1, skipped: 0,
        cases: [
          mkCase("LoginTest.ShouldLogin", "Passed", { stdout: "login debug" }),
          mkCase("LoginTest.ShouldFail", "Failed", { message: "Expected: true But was: false", stack: "at LoginTest.ShouldFail () [0x000010]" }),
          mkCase("PayTest.PayFlow", "Passed", { duration: 0.4 }),
        ],
      },
    },
  };
}

function legacyJob(id: number) {
  return {
    job_id: id, platform: "mac", status: "passed", created_at: 1,
    result: { success: true, summary: { total: 5, passed: 5, failed: 0, skipped: 0 } },
  };
}

describe("renderAllureHtml 纯函数", () => {
  it("无任务 → 空态，自包含", () => {
    const html = renderAllureHtml([]);
    expect(html).toContain("暂无测试数据");
    expect(html).toContain("<html");
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  it("默认最新含 cases 的 job：四 tab + 状态计数 + 用例/分类", () => {
    const html = renderAllureHtml([legacyJob(1), jobWithCases(2, 200)]);
    expect(html).toContain("Overview");
    expect(html).toContain("Suites");
    expect(html).toContain("Categories");
    expect(html).toContain("LoginTest.ShouldFail");
    expect(html).toContain("LoginTest.ShouldLogin");
    expect(html).toContain("PayTest.PayFlow");
    expect(html).toContain("Expected: true");
    expect(html).toContain("at LoginTest.ShouldFail");
    expect(html).toContain("login debug");
    expect(html).toContain("job-2");
  });

  it("指定历史 job（含 cases）", () => {
    const html = renderAllureHtml([jobWithCases(2, 200), jobWithCases(3, 300)], 2);
    expect(html).toContain("job-2");
    expect(html).toContain("LoginTest.ShouldFail");
  });

  it("旧 job 无 cases → 降级提示 + 汇总数字", () => {
    const html = renderAllureHtml([legacyJob(4)]);
    expect(html).toContain("无用例明细");
    expect(html).toContain("5");
    expect(html).not.toContain("Suites 组");
  });

  it("pending 无 result 任务被跳过", () => {
    const html = renderAllureHtml([{ job_id: 9, status: "pending", created_at: 1 }]);
    expect(html).toContain("暂无测试数据");
    expect(html).not.toContain("job-9");
  });

  it("全字段 HTML 转义（用例名含标签不注入）", () => {
    const j = jobWithCases(2, 200);
    (j.result.summary.cases as Case[])[0].fullname = "<img src=x onerror=alert(1)>";
    const html = renderAllureHtml([j]);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
  });

  it("历史下拉仅含带明细的 job", () => {
    const html = renderAllureHtml([legacyJob(1), jobWithCases(2, 200)]);
    expect(html).toContain("job-2");
    expect(html).not.toContain("value=\"1\"");
  });
});

describe("GET /allure 端点", () => {
  let dir: string;
  let staticDir: string;
  let store: Store;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-allure-"));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-astatic-"));
    store = new Store(dir);
    server = http.createServer(createGameqaServer(store, staticDir));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it("200 + text/html，渲染最新 job", async () => {
    store.appendJob(jobWithCases(2, 200) as never);
    const r = await fetch(`${base}/allure`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("LoginTest.ShouldFail");
    expect(html).toContain("<svg");
  });

  it("?job= 指定任务", async () => {
    store.appendJob(jobWithCases(2, 200) as never);
    store.appendJob(legacyJob(7) as never);
    const r = await fetch(`${base}/allure?job=7`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("无用例明细");
  });

  it("无数据 200 空态", async () => {
    const r = await fetch(`${base}/allure`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("暂无测试数据");
  });
});
