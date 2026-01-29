/**
 * Tracing Module - AsyncLocalStorage 封装
 * 
 * 职责：
 * 1. 管理请求级别的上下文 (Trace ID, User ID)
 * 2. 提供全链路追踪能力，解决并发日志混杂问题
 * 
 * 原理：
 * AsyncLocalStorage 能在异步函数调用链中"隐式"传递数据，
 * 相当于给单线程的 Node.js 开辟了"线程局部存储"。
 */

import { AsyncLocalStorage } from 'async_hooks';
import { nanoid } from 'nanoid';

/**
 * 追踪上下文结构
 */
export interface TraceContext {
    /** 唯一追踪 ID，用于串联一次请求的所有日志 */
    traceId: string;
    /** 用户 ID (Telegram Chat ID) */
    userId?: string;
    /** 额外的上下文数据 */
    extra?: Record<string, unknown>;
}

// 创建 AsyncLocalStorage 实例
const asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

/**
 * 生成唯一的 Trace ID
 * 使用 nanoid 生成 12 位短 ID，足够区分并发请求
 */
export function generateTraceId(): string {
    return nanoid(12);
}

/**
 * 在追踪上下文中运行异步函数
 * 
 * @param traceId - 追踪 ID
 * @param fn - 要执行的异步函数
 * @returns 函数执行结果
 * 
 * @example
 * await runWithTraceId(generateTraceId(), async () => {
 *     // 这里的所有代码（包括嵌套的异步调用）都能访问到 traceId
 *     logger.info({ message: 'Hello' }); // 自动带上 traceId
 * });
 */
export async function runWithTraceId<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const context: TraceContext = { traceId };
    return asyncLocalStorage.run(context, fn);
}

/**
 * 在追踪上下文中运行同步函数
 */
export function runWithTraceIdSync<T>(traceId: string, fn: () => T): T {
    const context: TraceContext = { traceId };
    return asyncLocalStorage.run(context, fn);
}

/**
 * 获取当前的追踪上下文
 * 如果不在追踪上下文中，返回 undefined
 */
export function getTraceContext(): TraceContext | undefined {
    return asyncLocalStorage.getStore();
}

/**
 * 获取当前的 Trace ID
 * 如果不在追踪上下文中，返回 undefined
 */
export function getTraceId(): string | undefined {
    return asyncLocalStorage.getStore()?.traceId;
}

/**
 * 获取当前的 User ID
 */
export function getUserId(): string | undefined {
    return asyncLocalStorage.getStore()?.userId;
}

/**
 * 设置当前上下文的 User ID
 * 必须在 runWithTraceId 内部调用
 */
export function setUserId(userId: string): void {
    const store = asyncLocalStorage.getStore();
    if (store) {
        store.userId = userId;
    }
}

/**
 * 设置额外的上下文数据
 * 必须在 runWithTraceId 内部调用
 */
export function setExtra(key: string, value: unknown): void {
    const store = asyncLocalStorage.getStore();
    if (store) {
        if (!store.extra) {
            store.extra = {};
        }
        store.extra[key] = value;
    }
}

/**
 * 获取额外的上下文数据
 */
export function getExtra(key: string): unknown {
    return asyncLocalStorage.getStore()?.extra?.[key];
}
