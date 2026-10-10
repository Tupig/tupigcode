/**
 * utils/atomic-write.ts — temp + rename 原子落盘（issue #90）
 *
 * 进程中断/并发写时目标文件要么旧要么新，不出现半写截断。
 * tmp 名含 pid + 随机后缀（fix #121：同 pid 并发不互踩）；失败路径清理 tmp。
 */
import { writeFileSync, renameSync, unlinkSync } from "fs";
import { writeFile, rename, unlink } from "fs/promises";
import { randomBytes } from "crypto";

function tmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = tmpPath(path);
  try {
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch { /* tmp 不存在 */ }
    throw err;
  }
}

export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = tmpPath(path);
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp 不存在 */ }
    throw err;
  }
}
