/**
 * e74: REPL 输入串扰防护——TurnGate（issue #86）
 *
 * 审批弹问的裸 stdin data 监听与 readline 共挂同一输入流，
 * 一次 y⏎ 双触发（line 幻影输入 + 审批 allow）。line handler 必须持 busy gate：
 * turn 进行中的行直接丢弃，审批 data 不受影响。
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TurnGate } from "../../src/services/turn-gate";

describe("TurnGate", () => {
  it("enter 成功后忙，exit 后可重入；不可嵌套", () => {
    const g = new TurnGate();
    expect(g.isBusy).toBe(false);
    expect(g.enter()).toBe(true);
    expect(g.isBusy).toBe(true);
    expect(g.enter()).toBe(false); // 拒绝重入
    g.exit();
    expect(g.isBusy).toBe(false);
    expect(g.enter()).toBe(true);
    g.exit();
  });
});

describe("复现：审批 y 与 readline 双监听串扰（issue #86）", () => {
  it("busy 期间写入的行不进 handler（幻影 y 被丢），审批 data 正常收到；exit 后恢复", async () => {
    const stdin = new PassThrough();
    stdin.setEncoding("utf-8");
    const rl = createInterface({ input: stdin });
    const gate = new TurnGate();
    const handled: string[] = [];
    const approvals: string[] = [];

    // 与 src/index.ts line handler 同构：busy 直接丢弃
    rl.on("line", (line: string) => {
      if (!gate.enter()) return;
      handled.push(line);
    });

    stdin.write("hello\n"); // 用户提交 → handler 进入 busy（模拟长 turn）
    await new Promise((r) => setTimeout(r, 20));
    expect(handled).toEqual(["hello"]);
    expect(gate.isBusy).toBe(true);

    // 审批弹问：裸 data 监听与 readline 共存（permissions.ts 同构）
    const approval = new Promise<void>((resolve) => {
      stdin.once("data", (d) => {
        approvals.push(String(d).trim());
        resolve();
      });
    });
    stdin.write("y\n"); // 同一输入双路分发
    await approval;
    await new Promise((r) => setTimeout(r, 20));

    expect(approvals).toEqual(["y"]); // 审批拿到 y
    expect(handled).toEqual(["hello"]); // 幻影 "y" 被 gate 拒，未进 handler

    gate.exit(); // turn 结束
    stdin.write("z\n");
    await new Promise((r) => setTimeout(r,20));
    expect(handled).toEqual(["hello", "z"]); // 恢复接收
    rl.close();
  });

  it("index.ts 接线：line handler 持 gate 且 finally 释放", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "index.ts"), "utf-8");
    expect(src).toMatch(/turnGate\.enter\(\)/);
    expect(src).toMatch(/turnGate\.exit\(\)/);
    expect(src).toMatch(/finally\s*\{/);
  });
});
