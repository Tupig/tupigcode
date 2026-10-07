/**
 * G6 测试报告：单文件 HTML + 轻量趋势（无外部依赖、内联 SVG）。对应 issue #7。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";
import { renderReportHtml } from "../../src/gameqa/report";

function okJob(id: number, ts: number, passed = 10, total = 10) {
  return {
    job_id: id, platform: "mac", status: "passed", created_at: ts,
    extra: { job_type: "generate_and_run" },
    result: { success: true, log_path: null, summary: { message: `测试通过 ${passed}/${total}`, total, passed, failed: total - passed, skipped: 0 } },
  };
}

function failJob(id: number, ts: number) {
  return {
    job_id: id, platform: "mac", status: "failed", created_at: ts,
    extra: { job_type: "generate_and_run" },
    result: {
      success: false, log_path: null,
      summary: {
        message: "测试失败 3/10", total: 10, passed: 7, failed: 3, skipped: 0,
        failures: [{ name: "LoginTest.ShouldLogin", message: "Expected true but was false" }],
      },
    },
  };
}

describe("renderReportHtml 纯函数", () => {
  it("无历史任务 → 空态文案，仍是合法单文件 HTML", () => {
    const html = renderReportHtml([]);
    expect(html).toContain("暂无测试数据");
    expect(html).toContain("<html");
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  it("汇总卡片：最新一次通过/失败数与通过率", () => {
    const html = renderReportHtml([okJob(1, 100, 8, 10), failJob(2, 200)]);
    expect(html).toContain("7"); // 最新 failed=3? 最新是 failJob(2): passed 7
    expect(html).toContain("70%");
    expect(html).toContain("80%"); // 早前一次
  });

  it("失败明细列出用例名", () => {
    const html = renderReportHtml([failJob(2, 200)]);
    expect(html).toContain("LoginTest.ShouldLogin");
    expect(html).toContain("Expected true but was false");
  });

  it("趋势为内联 SVG（≥2 点才有 polyline）", () => {
    const html = renderReportHtml([okJob(1, 100, 8, 10), okJob(2, 200, 10, 10)]);
    expect(html).toContain("<svg");
    expect(html).toMatch(/<polyline[^>]*points="[^"]+"/);
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('src="http');
  });

  it("历史表含每条任务（通过/失败状态文案）", () => {
    const html = renderReportHtml([okJob(1, 100), failJob(2, 200)]);
    expect(html).toContain("通过");
    expect(html).toContain("失败");
    expect(html).toContain("job-1");
    expect(html).toContain("job-2");
  });

  it("无 result 的 pending 任务被跳过", () => {
    const html = renderReportHtml([
      { job_id: 9, platform: "mac", status: "pending", created_at: 1 },
      okJob(1, 100),
    ]);
    expect(html).not.toContain("job-9");
    expect(html).toContain("job-1");
  });
});

describe("GET /report 端点集成", () => {
  let dir: string;
  let staticDir: string;
  let store: Store;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-report-"));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-rstatic-"));
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

  it("200 + text/html，含历史数据", async () => {
    store.appendJob(okJob(1, 100) as never);
    const r = await fetch(`${base}/report`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("job-1");
    expect(html).toContain("<svg");
  });

  it("无数据也返回 200 空态", async () => {
    const r = await fetch(`${base}/report`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("暂无测试数据");
  });
});
