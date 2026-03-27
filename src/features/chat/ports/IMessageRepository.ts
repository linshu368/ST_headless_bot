import type { MessageLogRecord, CreditAccount } from '../domain/MessageLogRecord.js';

export interface OpenRouterStats {
    model: string;
    generation_time: number | 'failed'; // seconds
    latency: number | 'failed'; // seconds
    native_tokens_prompt: number | 'failed';
    native_tokens_completion: number | 'failed';
    native_tokens_reasoning: number | 'failed';
    native_tokens_cached: number | 'failed';
    cache_discount: number | 'failed';
    usage: number | 'failed'; // cost
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

    /**
     * 回写积分扣除结果
     * @param messageId 消息 ID
     * @param amount 实际扣除数; null 表示扣除失败
     * @param account 扣费账户; null 表示扣除失败或未扣费
     */
    updateCreditsDeducted(messageId: string, amount: number | null, account: CreditAccount | null): Promise<void>;
}
