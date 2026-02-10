import type { MessageLogRecord } from '../domain/MessageLogRecord.js';

/**
 * Layer C: Port - 消息持久化仓库接口
 * 声明对消息存储的需求，不关心具体实现（Supabase/Postgres/File）
 */
export interface IMessageRepository {
    /**
     * 异步保存消息记录
     * @param record 待保存的消息记录
     */
    saveMessage(record: MessageLogRecord): Promise<void>;
}
