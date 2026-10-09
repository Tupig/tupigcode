/**
 * utils/atomicWrite.ts — temp + rename 原子落盘（issue #90）
 *
 * 进程中断/并发写时目标文件要么旧要么新，不出现半写截断。
 */
import { writeFileSync, renameSync } from "fs";
import { writeFile, rename } from "fs/promises";

function tmpPath(path: string): string {
  return `${path}.${process.pid}.tmp`;
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = tmpPath(path);
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, path);
}

export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = tmpPath(path);
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}
