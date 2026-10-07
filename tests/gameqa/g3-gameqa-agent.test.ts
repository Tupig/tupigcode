/**
 * G3 gameqa Agent：Unity 真实执行 + 执行器分发 + 全链路（server→poll→执行→上报）。
 * Unity 用可执行假脚本模拟 batchmode 行为（写 results.xml / logFile / 按 mode 退出）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";
import { execute, runAgent } from "../../src/gameqa/agent";
import { parseNUnitXml, tailUtf8, resolveUnityBinary } from "../../src/gameqa/unity";
import { scanLogText, defaultPlayerLog, runLogScan, runDeviceInventory, executeAgentJobType } from "../../src/gameqa/executors";

const PASS_XML = `<?xml version="1.0"?>
<test-run id="1" testcasecount="3" result="Passed" total="3" passed="3" failed="0" inconclusive="0" skipped="0">
  <test-suite type="Assembly" name="Tests">
    <test-case name="Ok.A" result="Passed"/>
    <test-case name="Ok.B" result="Passed"/>
    <test-case name="Ok.C" result="Passed"/>
  </test-suite>
</test-run>`;

const FAIL_XML = `<?xml version="1.0"?>
<test-run id="1" testcasecount="2" result="Failed" total="2" passed="1" failed="1" inconclusive="0" skipped="0">
  <test-suite type="Assembly" name="Tests">
    <test-case fullname="Suite.Ok" name="Ok" result="Passed"/>
    <test-case fullname="Suite.FailCase" name="FailCase" result="Failed" fullname2="x">
      <failure>
        <message><![CDATA[Expected: true But was: false]]></message>
        <stack-trace>at Suite.FailCase () [0x00000]</stack-trace>
      </failure>
    </test-case>
  </test-suite>
</test-run>`;

const FAKE_UNITY = `#!/bin/sh
MODE="\${FAKE_UNITY_MODE:-pass}"
PROJECT=""; RESULTS=""; LOGF=""; FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    -projectPath) PROJECT="$2"; shift 2;;
    -testResults) RESULTS="$2"; shift 2;;
    -logFile) LOGF="$2"; shift 2;;
    -testFilter) FILTER="$2"; shift 2;;
    *) shift;;
  esac
done
{
  echo "filter=$FILTER"
  echo "mode=$MODE"
  ls "$PROJECT/Assets/Tests/Generated" 2>/dev/null || echo "no-gen-dir"
} > "$LOGF" 2>/dev/null
case "$MODE" in
  pass)
    cat > "$RESULTS" <<'XMLEOF'
${PASS_XML}
XMLEOF
    exit 0;;
  fail)
    cat > "$RESULTS" <<'XMLEOF'
${FAIL_XML}
XMLEOF
    exit 2;;
  crash)
    echo "error CS1002: ; expected" >> "$LOGF"
    exit 1;;
  sleep)
    sleep 5
    exit 0;;
esac
`;

let dir: string;
let proj: string;
let fakeUnity: string;
const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, val: string | undefined): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

function job(extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, any> {
  return { job_id: 7, platform: "mac", extra, ...top };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-agent-"));
  proj = path.join(dir, "UnityProj");
  fs.mkdirSync(proj, { recursive: true });
  fakeUnity = path.join(dir, "fake-unity.sh");
  fs.writeFileSync(fakeUnity, FAKE_UNITY.replace("__PASS__", PASS_XML).replace("__FAIL__", FAIL_XML), { mode: 0o755 });
  setEnv("UNITY_PATH", fakeUnity);
  setEnv("FAKE_UNITY_MODE", "pass");
  setEnv("PLATFORM_URL", undefined);
  setEnv("AGENT_ID", undefined);
  setEnv("AGENT_SKILLS", undefined);
  setEnv("MCP_SERVER_URL", undefined);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

describe("NUnit3 XML 解析", () => {
  it("通过样本", () => {
    const s = parseNUnitXml(PASS_XML);
    expect(s).not.toBeNull();
    expect(s!.result).toBe("Passed");
    expect(s!.total).toBe(3);
    expect(s!.passed).toBe(3);
    expect(s!.failed).toBe(0);
    expect(s!.failures).toHaveLength(0);
  });

  it("失败样本含用例明细与 CDATA 消息", () => {
    const s = parseNUnitXml(FAIL_XML);
    expect(s!.result).toBe("Failed");
    expect(s!.failed).toBe(1);
    expect(s!.passed).toBe(1);
    expect(s!.failures).toHaveLength(1);
    expect(s!.failures[0].name).toBe("Suite.FailCase");
    expect(s!.failures[0].message).toContain("Expected: true");
  });

  it("无法识别返回 null", () => {
    expect(parseNUnitXml("")).toBeNull();
    expect(parseNUnitXml("<root/>")).toBeNull();
  });

  const RICH_XML = `<?xml version="1.0"?>
<test-run id="1" testcasecount="3" result="Failed" total="3" passed="1" failed="1" skipped="1" inconclusive="0">
  <test-suite type="Assembly" name="Tests">
    <test-case fullname="LoginTest.ShouldLogin" name="ShouldLogin" classname="LoginTest" result="Passed" duration="0.25"/>
    <test-case fullname="LoginTest.ShouldFail" name="ShouldFail" classname="LoginTest" result="Failed" duration="1.5">
      <output><![CDATA[debug log line]]></output>
      <failure>
        <message><![CDATA[Expected: true But was: false]]></message>
        <stack-trace><![CDATA[at LoginTest.ShouldFail () [0x000010]]></stack-trace>
      </failure>
    </test-case>
    <test-case fullname="LoginTest.SkippedOne" name="SkippedOne" classname="LoginTest" result="Skipped" duration="0"/>
  </test-suite>
</test-run>`;

  it("cases 提取全部用例（Passed/Failed/Skipped）：fullname/classname/result/duration", () => {
    const s = parseNUnitXml(RICH_XML);
    expect(s!.cases).toHaveLength(3);
    expect(s!.cases[0]).toMatchObject({
      fullname: "LoginTest.ShouldLogin",
      classname: "LoginTest",
      result: "Passed",
      duration: 0.25,
    });
    expect(s!.cases[2].result).toBe("Skipped");
    // failures 数组保持只含失败用例（现状回归）
    expect(s!.failures).toHaveLength(1);
    expect(s!.failures[0].name).toBe("LoginTest.ShouldFail");
  });

  it("cases 含失败用例的 message/stack 与 stdout", () => {
    const s = parseNUnitXml(RICH_XML);
    const failed = s!.cases.find((c) => c.result === "Failed")!;
    expect(failed.message).toContain("Expected: true");
    expect(failed.stack).toContain("at LoginTest.ShouldFail");
    expect(failed.stdout).toContain("debug log line");
  });

  it("cases 上限 2000 条截断，单字段 4KB 截断", () => {
    const many = Array.from({ length: 2005 }, (_, i) =>
      `<test-case fullname="Big.Suite.Case${i}" name="Case${i}" classname="Big.Suite" result="Passed" duration="0.01"/>`,
    ).join("\n");
    const xml = `<test-run total="2005" passed="2005" failed="0" result="Passed">${many}</test-run>`;
    const s = parseNUnitXml(xml);
    expect(s!.cases).toHaveLength(2000);

    const longMsg = "x".repeat(10_000);
    const xml2 = `<test-run total="1" failed="1" result="Failed">
      <test-case fullname="A.B" name="B" classname="A" result="Failed" duration="1">
        <failure><message><![CDATA[${longMsg}]]></message></failure>
      </test-case>
    </test-run>`;
    const s2 = parseNUnitXml(xml2);
    expect(s2!.cases[0].message!.length).toBeLessThanOrEqual(4096);
  });

  it("无 test-case → cases 空数组", () => {
    const s = parseNUnitXml(`<test-run total="0" passed="0" failed="0" result="Passed"></test-run>`);
    expect(s!.cases).toEqual([]);
  });
});

describe("tailUtf8", () => {
  it("短内容原样；超长截尾并带截断标记", () => {
    expect(tailUtf8(Buffer.from("hello"), 1024)).toBe("hello");
    const long = Buffer.from("甲".repeat(50_000));
    const t = tailUtf8(long, 1024);
    expect(t.length).toBeLessThanOrEqual(1024 + 30);
    expect(t).toContain("已截断");
  });
});

describe("execute()：Unity 真实执行", () => {
  it("通过路径：exit 0 + results.xml → success，产物含 unity.log/results.xml", async () => {
    const out = await execute(job({}, { unity_project_path: proj }), path.join(dir, "w1"));
    expect(out.success).toBe(true);
    expect(out.summary["message"]).toBe("测试通过 3/3");
    expect(out.summary["total"]).toBe(3);
    expect(out.logPath).toContain("unity.log");
    expect(out.artifacts.map((a) => a[0])).toEqual(expect.arrayContaining(["unity.log", "results.xml"]));
  });

  it("失败路径：exit 2 → success=false 且列出失败用例", async () => {
    setEnv("FAKE_UNITY_MODE", "fail");
    const out = await execute(job({}, { unity_project_path: proj }), path.join(dir, "w2"));
    expect(out.success).toBe(false);
    expect(out.summary["message"]).toBe("测试失败 1/2");
    const failures = out.summary["failures"] as any[];
    expect(failures[0].name).toBe("Suite.FailCase");
    expect(failures[0].message).toContain("Expected: true");
  });

  it("编译崩溃：exit 1 无 XML → 报退出码与编译提示", async () => {
    setEnv("FAKE_UNITY_MODE", "crash");
    const out = await execute(job({}, { unity_project_path: proj }), path.join(dir, "w3"));
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("Unity 退出码 1");
    expect(String(out.summary["message"])).toContain("编译失败");
  });

  it("超时强制终止", async () => {
    setEnv("FAKE_UNITY_MODE", "sleep");
    const out = await execute(job({ timeout_minutes: 0.0017 }, { unity_project_path: proj }), path.join(dir, "w4"));
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("超时");
  }, 10_000);

  it("缺少 unity_project_path → 结构化失败", async () => {
    const out = await execute(job(), path.join(dir, "w5"));
    expect(out.success).toBe(false);
    expect(out.summary["message"]).toBe("缺少 unity_project_path");
  });

  it("test_filter 透传（顶层与 extra 均可）", async () => {
    const out = await execute(job({ test_filter: "Foo.Bar" }, { unity_project_path: proj }), path.join(dir, "w6"));
    expect(out.success).toBe(true);
    const log = fs.readFileSync(out.logPath!, "utf-8");
    expect(log).toContain("filter=Foo.Bar");
  });

  it("generate_and_run：写入 Generated_{id}.cs → 带 -testFilter Generated 执行 → 执行后清理", async () => {
    const out = await execute(
      job({ job_type: "generate_and_run", generated_test_csharp: "public class Generated_7 {}" }, { unity_project_path: proj }),
      path.join(dir, "w7"),
    );
    expect(out.success).toBe(true);
    const log = fs.readFileSync(out.logPath!, "utf-8");
    expect(log).toContain("filter=Generated");
    expect(log).toContain("Generated_7.cs");
    // 执行后清理（默认）
    expect(fs.existsSync(path.join(proj, "Assets/Tests/Generated/Generated_7.cs"))).toBe(false);
  });

  it("generate_and_run：keep_generated=true 保留文件", async () => {
    const out = await execute(
      job({ job_type: "generate_and_run", generated_test_csharp: "public class G {}", keep_generated: true }, { unity_project_path: proj }),
      path.join(dir, "w8"),
    );
    expect(out.success).toBe(true);
    expect(fs.existsSync(path.join(proj, "Assets/Tests/Generated/Generated_7.cs"))).toBe(true);
  });

  it("UNITY_PATH 未安装时结构化失败", async () => {
    setEnv("UNITY_PATH", path.join(dir, "not-exist-unity"));
    const out = await execute(job({}, { unity_project_path: proj }), path.join(dir, "w9"));
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("Unity 启动失败");
    expect(out.summary["hint"]).toContain("UNITY_PATH");
  });
});

describe("执行器分发", () => {
  it("self_check 通过", async () => {
    const out = await execute(job({ job_type: "self_check" }), path.join(dir, "ws"));
    expect(out.success).toBe(true);
    expect(out.summary["node"]).toBe(process.version);
  });

  it("未知 job_type 走占位（与 Rust 版一致）", async () => {
    const out = await execute(job({ job_type: "unknown_x" }), path.join(dir, "wu"));
    expect(out.success).toBe(true);
    expect(out.summary["message"]).toBe("placeholder run");
  });

  it("ai_exploratory 缺 prompt → 结构化失败（对齐 Rust 测试）", async () => {
    for (const jt of ["airtest", "ai_exploratory", "game_perf"]) {
      const out = await executeAgentJobType(jt, job({ job_type: jt }), dir);
      expect(out!.success).toBe(false);
      expect(String(out!.summary["message"]).length).toBeGreaterThan(0);
    }
  });

  it("unity_log_scan：显式 log_path + 阈值判定 + 产物", () => {
    const logFile = path.join(dir, "player.log");
    fs.writeFileSync(logFile, "Unity v2022\nInvalidOperationException: boom\nat Foo()\nError: load fail\nall good\n");
    const wd = path.join(dir, "wl");

    const ok = runLogScan(job({ job_type: "unity_log_scan", log_path: logFile, max_errors: 10 }), wd);
    expect(ok.success).toBe(true);
    expect(ok.summary["error_count"]).toBe(2);
    expect(ok.summary["exceptions"]).toBe(1);
    expect(ok.artifacts[0][0]).toBe("log_errors.txt");
    expect(ok.artifacts[0][1]).toContain("L2: InvalidOperationException");

    const bad = runLogScan(job({ job_type: "unity_log_scan", log_path: logFile, max_errors: 0 }), wd);
    expect(bad.success).toBe(false);

    const missing = runLogScan(job({ job_type: "unity_log_scan", log_path: path.join(dir, "nope.log") }), wd);
    expect(missing.success).toBe(false);
    expect(String(missing.summary["message"])).toContain("日志文件不存在");
  });

  it("unity_log_scan 缺省路径（mac Player.log）", () => {
    expect(defaultPlayerLog("mac")).toContain("Library/Logs/Unity/Player.log");
    expect(defaultPlayerLog("web")).toBeNull();
    const noPath = runLogScan(job({ job_type: "unity_log_scan" }, { platform: "web" }), dir);
    expect(noPath.success).toBe(false);
    expect(noPath.summary["message"]).toContain("extra.log_path");
  });

  it("device_inventory：假 adb 枚举设备与属性", () => {
    const adb = path.join(dir, "fake-adb");
    fs.writeFileSync(
      adb,
      `#!/bin/sh
if [ "$1" = "-s" ]; then
  shift 2
  case "$*" in
    *ro.product.model*) echo "Pixel 8";;
    *ro.product.brand*) echo "Google";;
    *version.release*) echo "14";;
    *"wm size"*) echo "Physical size: 1080x2400";;
    *"dumpsys battery"*) echo "  level: 87";;
    *) echo "";;
  esac
else
  echo "List of devices attached"
  echo "emulator-5554\\tdevice"
  echo "old-device\\toffline"
fi
`,
      { mode: 0o755 },
    );
    setEnv("ADB_PATH", adb);
    const out = runDeviceInventory(path.join(dir, "wi"));
    expect(out.success).toBe(true);
    expect(out.summary["online"]).toBe(1);
    const devices = out.summary["devices"] as any[];
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ serial: "emulator-5554", online: true, model: "Google Pixel 8", android: "14", resolution: "1080x2400", battery: "87" });
    expect(devices[1]).toMatchObject({ serial: "old-device", note: "不可用" });
    expect(fs.readFileSync(path.join(dir, "wi", "devices.json"), "utf-8")).toContain("emulator-5554");
    setEnv("ADB_PATH", undefined);
  });
});

describe("全链路：server → agent poll → Unity 执行 → 上报", () => {
  let server: http.Server;
  let base: string;
  let store: Store;
  let srvDir: string;
  let staticDir: string;

  beforeEach(async () => {
    srvDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-a-srv-"));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-a-static-"));
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html></html>");
    store = new Store(srvDir);
    server = http.createServer(createGameqaServer(store, staticDir));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setEnv("PLATFORM_TOKEN", undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(srvDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  async function api(method: string, p: string, body?: unknown): Promise<any> {
    const resp = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  it("注册→领取→执行→passed→产物可查", async () => {
    const created = await api("POST", "/api/jobs", {
      platform: "mac",
      required_skills: ["PlayMode"],
      unity_project_path: proj,
      test_filter: "Suite.A",
      extra: {},
    });
    expect(created.ok).toBe(true);

    await runAgent({ platform: "mac", baseUrl: base, agentId: "ag-full", workRoot: path.join(dir, "runs"), maxIterations: 2, pollIntervalMs: 20 });

    const list = await api("GET", "/api/jobs");
    const j = list.items.find((x: any) => x.job_id === created.job_id);
    expect(j.status).toBe("passed");
    expect(j.result.summary.message).toBe("测试通过 3/3");
    expect(j.result.agent_id).toBe("ag-full");
    expect(j.result.log_path).toContain("unity.log");

    const artifacts = await api("GET", `/api/jobs/artifacts?job_id=${created.job_id}`);
    const names = (artifacts.files ?? artifacts).map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(["results.xml", "unity.log"]));

    // 第二轮空轮询：agent 未重复领取
    expect(await api("GET", "/api/jobs/poll/mac?skills=PlayMode")).toEqual({ job: null });
  }, 20_000);

  it("失败任务上报 failed", async () => {
    setEnv("FAKE_UNITY_MODE", "fail");
    const created = await api("POST", "/api/jobs", { platform: "mac", required_skills: ["PlayMode"], unity_project_path: proj, extra: {} });
    await runAgent({ platform: "mac", baseUrl: base, agentId: "ag-fail", workRoot: path.join(dir, "runs"), maxIterations: 2, pollIntervalMs: 20 });
    const j = (await api("GET", `/api/jobs/${created.job_id}`));
    expect(j.status).toBe("failed");
    expect(j.result.summary.failures[0].name).toBe("Suite.FailCase");
  }, 20_000);

  it("skills 不匹配时不领取", async () => {
    await api("POST", "/api/jobs", { platform: "mac", required_skills: ["WindowsOnly"], unity_project_path: proj, extra: {} });
    const r = await api("GET", "/api/jobs/poll/mac?skills=PlayMode");
    expect(r).toEqual({ job: null });
  });

  it("UNITY_PATH 解析顺序：环境变量优先", () => {
    expect(resolveUnityBinary()).toBe(fakeUnity);
  });
});
