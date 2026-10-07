/**
 * E20 wire.jsonl 原始报文轨迹（issue #16，对齐 Kimi wire.jsonl 思路）
 * 开关关零写 / 开启落盘可解析 / 流式合并完整 / 体积上限裁剪
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendWire, wireEnabled, wireFile, trimWireFile } from "../../src/utils/wire";
import { streamMessage } from "../../src/services/api";
import type { StreamEvent } from "../../src/services/api";

let dir: string;
let file: string;

function readLines(f: string): any[] {
  return fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-"));
  file = path.join(dir, "wire.jsonl");
  process.env.TUPIG_WIRE_FILE = file;
  delete process.env.TUPIG_WIRE;
  delete process.env.TUPIG_WIRE_MAX_BYTES;
});

afterEach(() => {
  delete process.env.TUPIG_WIRE;
  delete process.env.TUPIG_WIRE_FILE;
  delete process.env.TUPIG_WIRE_MAX_BYTES;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("开关与落盘", () => {
  it("开关关：wireEnabled false 且 appendWire 零写（文件不创建）", () => {
    expect(wireEnabled()).toBe(false);
    appendWire({ kind: "llm.request", data: { a: 1 } });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("TUPIG_WIRE=1 开启：落盘可解析，含 ts/req_id/kind/data", () => {
    process.env.TUPIG_WIRE = "1";
    expect(wireEnabled()).toBe(true);
    expect(wireFile()).toBe(file);
    const reqId = appendWire({ kind: "llm.request", provider: "mock", model: "m1", data: { messages: [] } })!;
    appendWire({ kind: "llm.response", provider: "mock", model: "m1", data: { text: "hi" }, req_id: reqId });
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(typeof l.ts).toBe("string");
      expect(l.req_id).toBeTruthy();
      expect(l.kind).toMatch(/^llm\./);
    }
    expect(lines[1].data.text).toBe("hi");
    expect(lines[0].req_id).toBe(lines[1].req_id); // 同一次交换共享 req_id
  });
});

describe("流式合并完整（streamMessage 包装）", () => {
  it("mock 客户端：request + response 两行，response 含合并后完整正文", async () => {
    process.env.TUPIG_WIRE = "1";
    const events: StreamEvent[] = [];
    const client = { type: "mock" as const };
    for await (const ev of streamMessage(client as any, "mock-model", 100, "sys", [], [])) {
      events.push(ev);
    }
    expect(events.length).toBeGreaterThan(3);

    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("llm.request");
    expect(lines[0].data.tools).toEqual([]);
    expect(lines[1].kind).toBe("llm.response");
    const text = lines[1].data.text;
    expect(text).toContain("Mock 模式");
    expect(lines[1].data.done).toBe(true);
    expect(lines[1].provider).toBe("mock");
    expect(lines[1].model).toBe("mock-model");
  });

  it("开关关：streamMessage 不写任何行", async () => {
    const client = { type: "mock" as const };
    for await (const _ of streamMessage(client as any, "m", 100, "s", [], [])) { /* consume */ }
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("体积上限滚动裁剪", () => {
  it("超过 TUPIG_WIRE_MAX_BYTES → 保留尾部完整行且仍可解析", () => {
    process.env.TUPIG_WIRE = "1";
    process.env.TUPIG_WIRE_MAX_BYTES = "2048";
    for (let i = 0; i < 60; i++) {
      appendWire({ kind: "llm.request", data: { i, pad: "x".repeat(200) } });
    }
    const size = fs.statSync(file).size;
    expect(size).toBeLessThan(2048 * 2);
    const lines = readLines(file); // 解析不抛 = 行完整
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1].data.i).toBe(59); // 最新保留
    expect(lines.every((l) => l.data.pad.length === 200)).toBe(true); // 无半行
  });

  it("trimWireFile 幂等：已低于上限时原样返回", () => {
    fs.writeFileSync(file, '{"ts":"t","req_id":"r","kind":"llm.request","data":{"a":1}}\n');
    const before = fs.readFileSync(file, "utf-8");
    trimWireFile(file, 10_000);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
});
