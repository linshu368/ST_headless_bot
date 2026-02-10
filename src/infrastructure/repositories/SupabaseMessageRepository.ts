import { supabase } from '../supabase/SupabaseClient.js';
import type { IMessageRepository } from '../../features/chat/ports/IMessageRepository.js';
import type { MessageLogRecord } from '../../features/chat/domain/MessageLogRecord.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseMessageRepository';

/**
 * Layer D: Adapter - 使用 Supabase 实现消息存储
 */
export class SupabaseMessageRepository implements IMessageRepository {
    async saveMessage(record: MessageLogRecord): Promise<void> {
        if (!supabase) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Supabase client not initialized, skipping persist' });
            return;
        }

        try {
            const { error } = await supabase
                .from('messages')
                .insert({
                    user_id: record.user_id,
                    role_id: record.role_id,
                    user_input: record.user_input,
                    bot_reply: record.bot_reply,
                    instructions: record.instructions,
                    history: record.history,
                    model_name: record.model_name,
                    attempt_count: record.attempt_count,
                    type: record.type,
                    // timestamp: database trigger will handle this
                });

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: 'Failed to insert message', error });
            } else {
                logger.debug({ kind: 'infra', component: COMPONENT, message: 'Message persisted successfully', meta: { userId: record.user_id } });
            }
        } catch (err) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during message persist', error: err });
        }
    }
}
