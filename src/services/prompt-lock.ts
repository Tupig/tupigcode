/**
 * 交互式询问串行锁（issue #64）
 *
 * 同一时刻只允许一个 readline 弹问在等待输入（审批 / hook 信任询问等），
 * 后续调用按到达顺序排队，前一个 settle（答复/超时/异常）后才开始下一个。
 * 非交互式快速拒绝应在调用本锁**之前**短路，不占队列。
 */
let tail: Promise<void> = Promise.resolve();

export async function withPromptLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = tail;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
