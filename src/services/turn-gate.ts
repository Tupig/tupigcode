/**
 * services/turnGate.ts — REPL 输入重入门闩（issue #86）
 *
 * 审批弹问的裸 stdin data 监听与 readline 共挂同一输入流，一次 y⏎ 双触发；
 * line handler 持 gate：turn 进行中的行直接丢弃，杜绝幻影 prompt 与并发 query。
 */
export class TurnGate {
  private busy = false;

  /** 尝试进入：busy 时返回 false（调用方丢弃该输入） */
  enter(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  exit(): void {
    this.busy = false;
  }

  get isBusy(): boolean {
    return this.busy;
  }
}
