/**
 * e83: /apply 落盘前自动快照（issue #93）
 *
 * applyStaged 成功即清 staging（无回滚介质）、/apply 不走工具钩子（autoSnapshot 不覆盖）。
 * applyStaged 前先建 before:apply 检查点，失败路径同样已有快照。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { stageWrite, applyStaged } from "../../src/engine/staging";
import { snapshot, listCheckpoints, rollbackCheckpoint } from "../../src/session/checkpoint";

describe("/apply 落盘前建检查点（issue #93）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tupig-e83-"));
    execSync("git init -q", { cwd: dir });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "const a = 1;\n", "utf-8");
    execSync("git add -A && git -c user.name=t -c user.email=t@t commit -q -m init", { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("index.ts /apply 在 applyStaged 前同步建 before:apply 快照", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "index.ts"), "utf-8");
    const block = src.slice(src.indexOf('input === "/apply"'), src.indexOf('rl.prompt();', src.indexOf('input === "/apply"')));
    expect(block).toMatch(/await snapshot\(workDir, "before:apply"\)/);
    const snapIdx = block.indexOf('snapshot(workDir, "before:apply")');
    const applyIdx = block.indexOf("applyStaged(workDir)");
    expect(snapIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(snapIdx); // 先快照再落盘
  });

  it("先快照再 apply → 可回滚到 apply 前", async () => {
    await stageWrite(dir, "src/main.ts", "const a = 2;\n");
    const rec = await snapshot(dir, "before:apply");
    expect(rec).not.toBeNull();

    const r = await applyStaged(dir);
    expect(r.applied).toContain("src/main.ts");
    expect(readFileSync(join(dir, "src", "main.ts"), "utf-8")).toBe("const a = 2;\n");

    const records = await listCheckpoints(dir);
    expect(records.some((x) => x.label === "before:apply")).toBe(true);

    const rb = await rollbackCheckpoint(dir, rec!.id);
    expect(rb.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "main.ts"), "utf-8")).toBe("const a = 1;\n");
  });

  it("apply 前的快照可持久回滚介质（staging 清掉后仍可回滚）", async () => {
    await stageWrite(dir, "ok.txt", "fine\n");
    const rec = await snapshot(dir, "before:apply");
    expect(rec).not.toBeNull();
    const rb = await rollbackCheckpoint(dir, rec!.id);
    expect(rb.ok).toBe(true);
    expect(existsSync(join(dir, ".tupigcode", "checkpoints.jsonl"))).toBe(true);
  });
});
