/**
 * G4 gameqa 集成执行器：airtest / game_perf / ai_exploratory（Rust 移植回归）。
 * airtest 与 gameperf 用假 CLI/假 adb 端到端；ai 用 mock OpenAI + 假 adb 走完整决策循环。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { buildDeviceUri, findAirtestCmd, runAirtestScript, urlencode, regexEscape } from "../../src/gameqa/airtest";
import { parseGfxinfo, parseMeminfoTotal, runGamePerf } from "../../src/gameqa/gameperf";
import {
  parseAction,
  validateAction,
  toPixels,
  parsePngSize,
  parseWmSize,
  escapeInputText,
  buildStepMessages,
  runAiExploratory,
} from "../../src/gameqa/ai";

let dir: string;
const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, val: string | undefined): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-int-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

function writeExecutable(p: string, content: string): string {
  fs.writeFileSync(p, content, { mode: 0o755 });
  return p;
}

function job(extra: Record<string, unknown>): Record<string, any> {
  return { job_id: 9, platform: "android", extra };
}

// ---------- airtest ----------

describe("airtest 设备 URI", () => {
  it("android：显式 serial / 环境变量 / 空", () => {
    expect(buildDeviceUri("android", { device_serial: "emulator-5554" })).toBe("Android:///emulator-5554");
    setEnv("ANDROID_SERIAL", "env-serial");
    expect(buildDeviceUri("android", {})).toBe("Android:///env-serial");
    setEnv("ANDROID_SERIAL", undefined);
    expect(buildDeviceUri("android", {})).toBe("Android:///");
  });

  it("windows：title_re 优先，title 转义，缺省根", () => {
    expect(buildDeviceUri("windows", { window_title_re: "My.*Game" })).toBe("Windows:///?title_re=My.%2AGame");
    expect(buildDeviceUri("windows", { window_title: "My Game (32-bit)" })).toBe(
      `Windows:///?title_re=${urlencode(regexEscape("My Game (32-bit)"))}`,
    );
    expect(buildDeviceUri("windows", {})).toBe("Windows:///");
  });

  it("不支持平台抛错", () => {
    expect(() => buildDeviceUri("mac", {})).toThrow("不支持");
  });
});

describe("runAirtestScript", () => {
  it("脚本不存在 → 结构化失败", async () => {
    const out = await runAirtestScript(job({ script_path: path.join(dir, "nope.air") }), "android", dir);
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("脚本不存在");
    expect(out.summary["hint"]).toContain(".air");
  });

  it("不支持的平台 → 结构化失败", async () => {
    const script = path.join(dir, "demo.air");
    fs.mkdirSync(script);
    const out = await runAirtestScript(job({ script_path: script }), "ios", dir);
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("不支持");
  });

  it("假 airtest CLI：成功 / 失败 / 产物", async () => {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    // 覆盖 PATH，使 findAirtestCmd 命中假 CLI
    setEnv("PATH", `${binDir}:${process.env["PATH"] ?? ""}`);
    writeExecutable(
      path.join(binDir, "airtest"),
      `#!/bin/sh
if [ "$1" = "run" ]; then
  # $2=script $4=device $6=logdir
  echo "run $2 device=$4" > "$6/log.txt"
  echo "stdout-line"
  [ "$FAKE_AIRTEST_FAIL" = "1" ] && { echo "boom" >&2; exit 3; }
  exit 0
fi
exit 2
`,
    );
    const script = path.join(dir, "demo.air");
    fs.mkdirSync(script);
    const wd = path.join(dir, "aw");

    const ok = await runAirtestScript(job({ script_path: script, timeout: 60 }), "android", wd);
    expect(ok.success).toBe(true);
    expect(ok.summary["message"]).toBe("airtest 脚本执行成功");
    expect(ok.summary["device"]).toBe("Android:///");
    expect(ok.logPath).toContain(path.join("airtest_log", "log.txt"));
    expect(fs.readFileSync(path.join(wd, "airtest_stdout.log"), "utf-8")).toContain("stdout-line");

    setEnv("FAKE_AIRTEST_FAIL", "1");
    const bad = await runAirtestScript(job({ script_path: script, timeout: 60 }), "android", path.join(dir, "aw2"));
    expect(bad.success).toBe(false);
    expect(bad.summary["exit_code"]).toBe(3);
    expect(fs.readFileSync(path.join(dir, "aw2", "airtest_stderr.log"), "utf-8")).toContain("boom");
    setEnv("FAKE_AIRTEST_FAIL", undefined);
  });

  it("findAirtestCmd：PATH 命中假 CLI", () => {
    const binDir = path.join(dir, "bin2");
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, "airtest"), "#!/bin/sh\nexit 0");
    setEnv("PATH", `${binDir}:${process.env["PATH"] ?? ""}`);
    expect(findAirtestCmd()[0]).toBe(path.join(binDir, "airtest"));
  });
});

// ---------- game_perf ----------

const GFX_SAMPLE = `*** GPU INFO ***
Total frames rendered: 900
Janky frames: 45 (5.00%)
50th percentile: 6ms
90th percentile: 11ms
95th percentile: 16ms
99th percentile: 28ms
Number Missed Vsync: 3`;

describe("game_perf 解析", () => {
  it("parseGfxinfo", () => {
    const s = parseGfxinfo(GFX_SAMPLE);
    expect(s).toEqual({ frames: 900, janky: 45, jank_pct: 5.0, p50: 6, p90: 11, p95: 16, p99: 28 });
    expect(parseGfxinfo("no stats here").frames).toBe(0);
  });

  it("parseMeminfoTotal", () => {
    expect(parseMeminfoTotal("Apps Summary\nTOTAL PSS: 512000 kB\nOther line")).toBeCloseTo(500.0);
    expect(parseMeminfoTotal("nothing")).toBeNull();
  });
});

describe("runGamePerf", () => {
  it("缺 package → 结构化失败", async () => {
    const out = await runGamePerf(job({}), dir);
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("extra.package");
  });

  it("package/launch_activity 含 shell 元字符 → 拒绝（fix #118 adb 注入）", async () => {
    const bad1 = await runGamePerf(job({ package: "com.example.game; rm -rf /data/local/tmp" }), dir);
    expect(bad1.success).toBe(false);
    expect(String(bad1.summary["message"])).toContain("非法字符");
    const bad2 = await runGamePerf(
      job({ package: "com.example.game", launch_activity: "a/.A; reboot" }),
      dir,
    );
    expect(bad2.success).toBe(false);
    expect(String(bad2.summary["message"])).toContain("launch_activity");
  });

  it("假 adb 全流程：采样 5s → 帧率/内存/阈值断言 + gfxinfo 产物", async () => {
    const adb = path.join(dir, "fake-adb-perf");
    writeExecutable(
      adb,
      `#!/bin/sh
case "$*" in
  *"gfxinfo"*"reset"*) echo reset-ok;;
  *"gfxinfo"*)
    cat <<'EOF'
Total frames rendered: 200
Janky frames: 40 (20.00%)
50th percentile: 8ms
90th percentile: 20ms
95th percentile: 33ms
99th percentile: 55ms
EOF
    ;;
  *"meminfo"*) echo "  TOTAL PSS:   655360 kB";;
  *) echo "ignored";;
esac
`,
    );
    setEnv("ADB_PATH", adb);
    const out = await runGamePerf(job({ package: "com.example.game", duration_s: 5, max_jank_pct: 10 }), path.join(dir, "pw"));
    setEnv("ADB_PATH", undefined);

    expect(out.success).toBe(false); // 卡顿率 20% > 阈值 10%；fps=200/5=40 >=30
    expect(String(out.summary["message"])).toContain("卡顿率超限");
    expect(out.summary["fps"]).toBe(40);
    expect(out.summary["jank_pct"]).toBe(20);
    expect(out.summary["p95_ms"]).toBe(33);
    expect(out.summary["mem_max_mb"]).toBe(640);
    expect(out.success).toBe(false);
    expect(fs.readFileSync(path.join(dir, "pw", "gfxinfo.txt"), "utf-8")).toContain("Total frames rendered");
    expect(out.artifacts[0][0]).toBe("gfxinfo.txt");
  }, 30_000);
});

// ---------- ai_exploratory ----------

describe("ai 纯逻辑", () => {
  it("parseAction：裸 JSON / code fence / 带噪 / 无效", () => {
    expect(parseAction('{"action":"tap","x":0.5,"y":0.3}')!["action"]).toBe("tap");
    expect(parseAction('```json\n{"action":"finish","success":true,"reason":"ok"}\n```')!["action"]).toBe("finish");
    expect(parseAction('好的，下一步：{"action":"tap","x":0.1,"y":0.2} 请确认')!["x"]).toBe(0.1);
    expect(parseAction("我觉得应该点击设置按钮")).toBeNull();
    expect(parseAction("")).toBeNull();
    expect(parseAction("[1,2,3]")).toBeNull();
    expect(parseAction('{"action": broken')).toBeNull();
  });

  it("validateAction：坐标范围 / 未知动作 / finish 类型 / wait 范围 / key 注入拒绝", () => {
    expect(validateAction({ action: "tap", x: 0.1, y: 0.9 })).toBe(true);
    expect(validateAction({ action: "tap", x: 1.5, y: 0.1 })).toBe(false);
    expect(validateAction({ action: "fly", x: 0.1, y: 0.1 })).toBe(false);
    expect(validateAction({ action: "swipe", x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(true);
    expect(validateAction({ action: "finish", success: false })).toBe(true);
    expect(validateAction({ action: "finish", success: "yes" })).toBe(false);
    expect(validateAction({ action: "wait", seconds: 999 })).toBe(false);
    expect(validateAction({ action: "wait" })).toBe(true);
    expect(validateAction({ action: "key", key: "BACK" })).toBe(true);
    expect(validateAction({ action: "key", key: "KEYCODE_WAKEUP" })).toBe(true);
    expect(validateAction({ action: "key", key: "; reboot" })).toBe(false);
    expect(validateAction({ action: "key", key: "a b" })).toBe(false);
    expect(validateAction({ action: "key", key: "$(id)" })).toBe(false);
  });

  it("toPixels：截断取整 + swipe duration 默认/钳制", () => {
    expect(toPixels({ action: "tap", x: 0.5, y: 0.25 }, 1080, 1920)).toEqual({ action: "tap", x: 540, y: 480 });
    const sw = toPixels({ action: "swipe", x1: 0, y1: 0, x2: 1, y2: 1 }, 1000, 2000) as any;
    expect(sw.x1).toBe(0);
    expect(sw.y2).toBe(2000);
    expect(sw.duration).toBe(0.5);
    expect((toPixels({ action: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, duration: 99 }, 1, 1) as any).duration).toBe(10);
  });

  it("parseWmSize：Override 优先 / 单行失败不放弃", () => {
    expect(parseWmSize("Physical size: 1080x1920")).toEqual([1080, 1920]);
    expect(parseWmSize("Physical size: 1080x1920\r\nOverride size: 900x1600")).toEqual([900, 1600]);
    expect(parseWmSize("nothing")).toBeNull();
    expect(parseWmSize("Physical size: bad\nOverride size: 1080x1920")).toEqual([1080, 1920]);
  });

  it("parsePngSize：合法头 / 非法", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    expect(parsePngSize(png)).toEqual([1920, 1080]);
    expect(parsePngSize(Buffer.alloc(0))).toBeNull();
    expect(parsePngSize(Buffer.from("not a png at all....."))).toBeNull();
  });

  it("escapeInputText：空格转 %s，shell 敏感字符丢弃", () => {
    expect(escapeInputText("hello world")).toBe("hello%sworld");
    expect(escapeInputText("abc; rm -rf /")).toBe("abc%srm%s-rf%s");
    expect(escapeInputText("user-1.name")).toBe("user-1.name");
    expect(escapeInputText("192.168.1.1")).toBe("192.168.1.1");
  });

  it("buildStepMessages：任务 + 最近 8 条历史", () => {
    const history = [{ step: 1, action: { action: "tap" }, result: "ok", screenshot: "step_01.png" }];
    const msgs = buildStepMessages("打开设置面板", history);
    expect(msgs[0].role).toBe("system");
    const user = msgs[1].content as string;
    expect(user).toContain("打开设置面板");
    expect(user).toContain("历史步骤");
    expect(user).toContain("tap");
    const first = buildStepMessages("任务", []);
    expect((first[1].content as string)).toContain("无，这是第一步");
  });
});

describe("runAiExploratory", () => {
  it("缺 prompt / 缺 OPENAI_API_KEY / 非 android → 结构化失败", async () => {
    const noPrompt = await runAiExploratory(job({}), "android", dir);
    expect(noPrompt.summary["message"]).toContain("extra.prompt");

    setEnv("OPENAI_API_KEY", undefined);
    const noKey = await runAiExploratory(job({ prompt: "打开设置" }), "android", dir);
    expect(noKey.summary["message"]).toBe("OPENAI_API_KEY 未配置");

    setEnv("OPENAI_API_KEY", "sk-test");
    const wrongPlat = await runAiExploratory(job({ prompt: "打开设置" }), "mac", dir);
    expect(String(wrongPlat.summary["message"])).toContain("仅支持 android");
  });

  it("mock OpenAI + 假 adb：截图→决策 finish→steps.json", async () => {
    // 假 adb：exec-out screencap 输出最小合法 PNG；wm size / input 兜底
    const adb = path.join(dir, "fake-adb-ai");
    const pngFixture = path.join(dir, "fixture.png");
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(1920, 20);
    fs.writeFileSync(pngFixture, png);
    writeExecutable(
      adb,
      `#!/bin/sh
case "$1" in
  exec-out) cat "${pngFixture}";;
  shell)
    case "$*" in
      *"wm size"*) echo "Physical size: 1080x1920";;
      *) echo "ok";;
    esac;;
  *) echo "ok";;
esac
`,
    );
    setEnv("ADB_PATH", adb);

    // mock OpenAI：首轮返回非法 JSON（触发重试历史），次轮 finish
    let calls = 0;
    const mock = http.createServer((req, res) => {
      calls++;
      const content = calls === 1 ? "我认为应该点击" : '{"action":"finish","success":true,"reason":"设置面板已打开"}';
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const port = (mock.address() as AddressInfo).port;

    setEnv("OPENAI_API_KEY", "sk-test");
    setEnv("OPENAI_BASE_URL", `http://127.0.0.1:${port}/v1`);
    setEnv("OPENAI_VISION_MODEL", "mock-vision");

    const wd = path.join(dir, "aiw");
    const out = await runAiExploratory(job({ prompt: "打开设置面板", max_steps: 5 }), "android", wd);

    await new Promise<void>((r) => mock.close(() => r()));

    expect(calls).toBe(2);
    expect(out.success).toBe(true);
    expect(out.summary["message"]).toBe("AI 探索测试达成");
    expect(out.summary["model"]).toBe("mock-vision");
    expect(out.summary["steps"]).toBe(2);
    expect(out.summary["reason"]).toBe("设置面板已打开");
    expect(fs.existsSync(path.join(wd, "step_01.png"))).toBe(true);

    const steps = JSON.parse(fs.readFileSync(path.join(wd, "steps.json"), "utf-8"));
    expect(steps.success).toBe(true);
    expect(steps.steps[0].error).toContain("动作解析失败");
    expect(steps.steps[1].result).toBe("finish");
    // steps.json 产物由 dispatch 收集
    const { executeAgentJobType } = await import("../../src/gameqa/executors");
    const dispatched = await executeAgentJobType("ai_exploratory", job({ prompt: "x" }), wd);
    expect(dispatched!.artifacts.map((a) => a[0])).toContain("steps.json");
  }, 20_000);

  it("模型不可达 → 未达成并带原因", async () => {
    setEnv("ADB_PATH", "/usr/bin/true"); // screencap 无输出 → 截图为空
    setEnv("OPENAI_API_KEY", "sk-test");
    setEnv("OPENAI_BASE_URL", "http://127.0.0.1:1/v1");
    const out = await runAiExploratory(job({ prompt: "任务", max_steps: 2 }), "android", path.join(dir, "aiw2"));
    expect(out.success).toBe(false);
    expect(String(out.summary["message"])).toContain("未达成");
    expect(String(out.summary["reason"])).toContain("截图为空");
  }, 20_000);
});
