import type { MessageLogRecord } from '../domain/MessageLogRecord.js';

export interface OpenRouterStats {
    model: string;
    generation_time: number; // seconds
    latency: number; // seconds
    native_tokens_prompt: number;
    native_tokens_completion: number;
    native_tokens_reasoning: number;
    native_tokens_cached: number;
    cache_discount: number;
    usage: number; // cost
    finish_reason: string;
    provider_name: string;
}

/**
 * Layer C: Port - 消息持久化仓库接口
 * 声明对消息存储的需求，不关心具体实现（Supabase/Postgres/File）
 */
export interface IMessageRepository {
    /**
     * 异步保存消息记录
     * @param record 待保存的消息记录
     * @returns 消息记录的 ID (如果支持)
     */
    saveMessage(record: MessageLogRecord): Promise<string | null>;

    /**
     * 更新消息的 OpenRouter 统计信息
     * @param messageId 消息 ID
     * @param stats 统计数据
     */
    updateMessageStats(messageId: string, stats: OpenRouterStats): Promise<void>;
}
