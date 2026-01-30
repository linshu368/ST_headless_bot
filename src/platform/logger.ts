/**
 * Logger Module - 结构化日志系统
 * 
 * 设计原则：
 * 1. 异步写入 + 缓冲机制 (winston Stream)
 * 2. 结构化日志 (JSON 格式)
 * 3. 自动注入 Trace ID 和 User ID
 * 4. 日志分级 (debug/info/warn/error)
 * 5. 日志轮转 (按天切割，保留 14 天)
 * 6. 错误信息完整暴露 (不包裹原始错误)
 * 
 * 分类标签 (kind):
 * - biz: 业务日志 (Usecase 层) - 用于还原用户行为
 * - sys: 系统日志 (Adapter 层) - 用于定位 Bug
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { getTraceId, getUserId } from './tracing.js';
import config from './config.js';

// ============ 类型定义 ============

/** 日志分类 */
export type LogKind = 'biz' | 'sys';

/** 日志元数据 */
export interface LogMeta {
    /** 日志分类：biz=业务日志, sys=系统日志 */
    kind: LogKind;
    /** 组件名称 */
    component: string;
    /** 日志消息 */
    message: string;
    /** 错误对象 (可选) */
    error?: Error | unknown;
    /** 额外元数据 (可选) */
    meta?: Record<string, unknown>;
}

// ============ 配置 ============

/** 日志级别，从统一配置读取 */
const LOG_LEVEL = config.logging.level;

/** 日志目录，从统一配置读取 */
const LOG_DIR = config.logging.dir;

/** 是否为开发环境 */
const IS_DEV = process.env.NODE_ENV !== 'production';

// ============ 格式化函数 ============

/**
 * 序列化错误对象
 * 关键：保留完整的错误信息，不包裹原始错误
 */
function serializeError(error: unknown): Record<string, unknown> | undefined {
    if (!error) return undefined;
    
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            // 保留 cause 链 (ES2022 Error Cause)
            ...(error.cause ? { cause: serializeError(error.cause) } : {}),
            // 保留任何自定义属性
            ...Object.fromEntries(
                Object.entries(error).filter(([key]) => !['name', 'message', 'stack', 'cause'].includes(key))
            )
        };
    }
    
    // 非 Error 对象，尝试 JSON 序列化
    try {
        return { raw: error };
    } catch {
        return { raw: String(error) };
    }
}

/**
 * JSON 格式化器 (生产环境)
 */
const jsonFormat = winston.format.printf(({ level, message, timestamp, ...rest }) => {
    const traceId = getTraceId();
    const userId = getUserId();
    
    const logObject: Record<string, unknown> = {
        timestamp,
        level,
        traceId: traceId || '-',
        userId: userId || '-',
        ...rest,
        message,
    };
    
    // 处理错误对象
    if (rest.error) {
        logObject.error = serializeError(rest.error);
    }
    
    return JSON.stringify(logObject);
});

/**
 * Pretty 格式化器 (开发环境)
 */
const prettyFormat = winston.format.printf(({ level, message, timestamp, kind, component, error, meta }) => {
    const traceId = getTraceId() || '-';
    const userId = getUserId() || '-';
    
    // 基础行
    let output = `${timestamp} [${level.toUpperCase().padEnd(5)}] [${kind || 'sys'}] [${traceId}] [${userId}] ${component || 'App'}: ${message}`;
    
    // 错误详情 (关键：完整暴露错误信息)
    if (error) {
        const serialized = serializeError(error);
        if (serialized) {
            output += `\n  error: ${serialized.name} - ${serialized.message}`;
            if (serialized.stack) {
                // 打印完整堆栈，便于定位
                output += `\n  stack: ${serialized.stack}`;
            }
            if (serialized.cause) {
                output += `\n  cause: ${JSON.stringify(serialized.cause)}`;
            }
        }
    }
    
    // 元数据
    if (meta && Object.keys(meta).length > 0) {
        output += `\n  meta: ${JSON.stringify(meta)}`;
    }
    
    return output;
});

// ============ Transport 配置 ============

/**
 * 控制台 Transport
 */
const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.colorize({ all: IS_DEV }),
        IS_DEV ? prettyFormat : jsonFormat
    ),
});

/**
 * 文件 Transport (日志轮转)
 * - 按天切割
 * - 保留 14 天
 * - 单文件最大 50MB
 */
const fileTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',
    maxFiles: '14d',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        jsonFormat
    ),
});

// 文件轮转事件（可选：用于监控）
fileTransport.on('rotate', (oldFilename, newFilename) => {
    console.log(`[Logger] Log rotated: ${oldFilename} -> ${newFilename}`);
});

// ============ Logger 实例 ============

const winstonLogger = winston.createLogger({
    level: LOG_LEVEL,
    transports: [
        consoleTransport,
        fileTransport,
    ],
});

/**
 * 内部调试日志 Transport (仅文件)
 * 用于记录 ST 引擎内部产生的海量 console.log
 */
const internalFileTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'internal-%DATE%.log', // 独立的文件名
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',
    maxFiles: '3d', // 内部日志体积大，保留时间短一点
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        jsonFormat
    ),
});

const internalWinstonLogger = winston.createLogger({
    level: 'debug', // 内部日志通常比较详细
    transports: [
        internalFileTransport, // 只写入文件，不写入 Console
    ],
});

// ============ 封装的 Logger API ============

/**
 * 内部调试日志接口
 * 用于接管第三方库或遗留代码的 console 输出
 */
export const internalLogger = {
    debug: (message: string, ...args: any[]) => internalWinstonLogger.debug(message, { args }),
    info: (message: string, ...args: any[]) => internalWinstonLogger.info(message, { args }),
    warn: (message: string, ...args: any[]) => internalWinstonLogger.warn(message, { args }),
    error: (message: string, ...args: any[]) => internalWinstonLogger.error(message, { args }),
};

/**
 * 统一的日志接口
 * 
 * @example
 * // 业务日志 (Usecase 层)
 * logger.info({
 *     kind: 'biz',
 *     component: 'SimpleChat',
 *     message: 'Chat started',
 *     meta: { historyLength: 5 }
 * });
 * 
 * // 系统日志 (Adapter 层)
 * logger.error({
 *     kind: 'sys',
 *     component: 'FetchInterceptor',
 *     message: 'LLM request failed',
 *     error: error, // 传入原始错误对象
 *     meta: { url, status }
 * });
 */
export const logger = {
    debug: ({ message, ...rest }: LogMeta) => winstonLogger.debug(message, rest),
    info: ({ message, ...rest }: LogMeta) => winstonLogger.info(message, rest),
    warn: ({ message, ...rest }: LogMeta) => winstonLogger.warn(message, rest),
    error: ({ message, ...rest }: LogMeta) => winstonLogger.error(message, rest),
    
    /**
     * 原始 winston logger (用于特殊场景)
     */
    raw: winstonLogger,
};

// ============ 预留：报警接口 ============

/**
 * 报警处理器接口 (预留)
 * 未来接入飞书等报警渠道时实现
 */
export interface AlertHandler {
    send(level: string, data: LogMeta): Promise<void>;
}

/**
 * 注册报警处理器 (预留)
 * 
 * @example
 * // 未来实现
 * registerAlertHandler({
 *     send: async (level, data) => {
 *         if (level === 'error') {
 *             await fetch(FEISHU_WEBHOOK, { ... });
 *         }
 *     }
 * });
 */
let alertHandler: AlertHandler | null = null;

export function registerAlertHandler(handler: AlertHandler): void {
    alertHandler = handler;
    
    // 监听 error 级别日志
    winstonLogger.on('data', (info) => {
        if (info.level === 'error' && alertHandler) {
            alertHandler.send(info.level, info).catch((err) => {
                console.error('[Logger] Alert handler failed:', err);
            });
        }
    });
}

// ============ 便捷函数 ============

/**
 * 快速创建业务日志 (Usecase 层)
 */
export function bizLog(component: string, message: string, meta?: Record<string, unknown>) {
    logger.info({ kind: 'biz', component, message, meta });
}

/**
 * 快速创建系统日志 (Adapter 层)
 */
export function sysLog(component: string, message: string, meta?: Record<string, unknown>) {
    logger.info({ kind: 'sys', component, message, meta });
}

/**
 * 快速创建错误日志 (保留完整错误信息)
 */
export function errLog(kind: LogKind, component: string, message: string, error: unknown, meta?: Record<string, unknown>) {
    logger.error({ kind, component, message, error, meta });
}

export default logger;
