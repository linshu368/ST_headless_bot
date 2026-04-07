/**
 * 瞬态网络错误识别 — 公共工具
 *
 * 用于区分"短暂网络抖动"和"服务真正不可用"。
 * 被 globalErrorHandler、RuntimeConfigService、UpstashSessionStore 等共同复用。
 */

const TRANSIENT_NETWORK_PATTERNS = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'socket disconnected',
    'socket hang up',
    'EFATAL',
    'network socket disconnected',
    'TLS connection',
    'EPIPE',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'fetch failed',
];

export function isTransientNetworkError(err: unknown): boolean {
    const msg = err instanceof Error
        ? `${err.name} ${err.message} ${err.stack ?? ''}`
        : String(err);
    return TRANSIENT_NETWORK_PATTERNS.some(p => msg.includes(p));
}