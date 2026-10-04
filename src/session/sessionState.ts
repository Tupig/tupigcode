/**
 * 会话身份
 *
 * issue #92：原「断点续传」已失效（loadSession 恒 null、listSessions 零引用、
 * 半数字段无消费者）已降级——SessionState 仅保留实际消费的身份载体，
 * 消息持久化与 /resume 恢复由 session.ts 独占。
 */

export interface SessionState {
  /** 会话 ID（唯一活字段） */
  sessionId: string;
}

/**
 * 生成会话 ID
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * 创建会话状态
 */
export function createSessionState(sessionId: string): SessionState {
  return { sessionId };
}
