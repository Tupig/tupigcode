/**
 * utils/clipOutput.ts — 命令输出双端裁剪（issue #53）
 *
 * 长输出 head+tail 双端保留（中段丢弃），截断时标注原始大小/省略量/
 * keep 模式与可调 env；预算内原样返回。
 */
import { MAX_BASH_OUTPUT_CHARS } from "../engine/constants.js";

export type ClipKeep = "head" | "tail" | "both";

export type ClipResult = {
  text: string;
  clipped: boolean;
  originalLength: number;
  omittedLength: number;
};

/** 输出预算：TUPIG_BASH_OUTPUT_CHARS 覆盖，非法/非正回退默认 */
export function resolveBashOutputBudget(): number {
  const v = Number(process.env.TUPIG_BASH_OUTPUT_CHARS);
  return Number.isFinite(v) && v > 0 ? v : MAX_BASH_OUTPUT_CHARS;
}

function annotate(keep: ClipKeep, original: number, omitted: number): string {
  return `\n…（已截断：原始 ${original} 字符，省略 ${omitted} 字符；keep=${keep}，`
    + `TUPIG_BASH_OUTPUT_CHARS 可调）`;
}

export function clipOutput(
  text: string,
  keep: ClipKeep = "both",
  budget = resolveBashOutputBudget(),
): ClipResult {
  const originalLength = text.length;
  if (originalLength <= budget) {
    return { text, clipped: false, originalLength, omittedLength: 0 };
  }

  if (keep === "head") {
    const head = text.slice(0, budget);
    const omitted = originalLength - budget;
    return { text: head + annotate(keep, originalLength, omitted), clipped: true, originalLength, omittedLength: omitted };
  }
  if (keep === "tail") {
    const tail = text.slice(originalLength - budget);
    const omitted = originalLength - budget;
    return { text: tail + annotate(keep, originalLength, omitted), clipped: true, originalLength, omittedLength: omitted };
  }

  // both：head 60% + tail 40%，中段丢弃
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(originalLength - tailLen);
  const omitted = originalLength - headLen - tailLen;
  return {
    text: head + annotate(keep, originalLength, omitted) + tail,
    clipped: true,
    originalLength,
    omittedLength: omitted,
  };
}
