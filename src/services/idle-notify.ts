/**
 * services/idleNotify.ts — REPL 输入空闲计时（issue #52）
 *
 * 每次 rl.prompt() 布防（arm）、用户输入（line）重置（reset 后下次
 * prompt 重新布防）；一轮空闲只回调一次；ms<=0 关闭；dispose 兜底清定时器。
 */
export type IdleNotifier = {
  /** 布防：重置计时并启动（已通知过则不启动，等 reset） */
  arm: () => void;
  /** 用户输入后调用：解除「已通知」并重新布防 */
  reset: () => void;
  dispose: () => void;
};

export function createIdleNotifier(ms: number, onIdle: () => void): IdleNotifier {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let notified = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    arm: () => {
      clear();
      if (!(ms > 0) || notified) return;
      timer = setTimeout(() => {
        timer = null;
        notified = true;
        onIdle();
      }, ms);
    },
    reset: () => {
      notified = false;
      clear();
    },
    dispose: clear,
  };
}

/** 空闲通知阈值：TUPIG_IDLE_NOTIFY_MS（默认 300s，0/非法关闭） */
export function resolveIdleNotifyMs(): number {
  const v = Number(process.env.TUPIG_IDLE_NOTIFY_MS ?? 300_000);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
