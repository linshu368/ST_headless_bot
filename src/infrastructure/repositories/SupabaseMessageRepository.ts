import { supabase } from '../supabase/SupabaseClient.js';
import type { IMessageRepository, OpenRouterStats } from '../../features/chat/ports/IMessageRepository.js';
import type { MessageLogRecord } from '../../features/chat/domain/MessageLogRecord.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseMessageRepository';

/**
 * Layer D: Adapter - 使用 Supabase 实现消息存储
 */
export class SupabaseMessageRepository implements IMessageRepository {
    async saveMessage(record: MessageLogRecord): Promise<string | null> {
        if (!supabase) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Supabase client not initialized, skipping persist' });
            return null;
        }

        try {
            // 1. Calculate Round (if not provided)
            let round = record.round;
            if (round === undefined && record.role_id) {
                const { count, error: countError } = await supabase
                    .from('messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', record.user_id)
                    .eq('role_id', record.role_id);
                
                if (!countError && count !== null) {
                    round = count + 1;
                } else {
                    // Fallback to 1 if query fails
                    round = 1;
                }
            }

            // Ensure history is a string if it's an object/array
            const historyContent = typeof record.history === 'string' 
                ? record.history 
                : JSON.stringify(record.history);

            const { data, error } = await supabase
                .from('messages')
                .insert({
                    user_id: record.user_id,
                    role_id: record.role_id,
                    user_input: record.user_input,
                    bot_reply: record.bot_reply,
                    instructions: record.instructions,
                    history: historyContent,
                    model_name: record.model_name,
                    attempt_count: record.attempt_count,
                    type: record.type,
                    round: round,
                    full_response: record.full_response ? Math.round(record.full_response) : null
                    // timestamp: database trigger will handle this
                })
                .select('id')
                .single();

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: 'Failed to insert message', error });
                return null;
            } else {
                logger.debug({ kind: 'infra', component: COMPONENT, message: 'Message persisted successfully', meta: { userId: record.user_id, id: data?.id } });
                return data?.id || null;
            }
        } catch (err) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during message persist', error: err });
            return null;
        }
    }

    async updateMessageStats(messageId: string, stats: OpenRouterStats): Promise<void> {
        if (!supabase) return;

        try {
            const { error } = await supabase
                .from('messages')
                .update({
                    meta_model: stats.model, // OpenRouter model name (might be more specific)
                    meta_generation_time: stats.generation_time,
                    meta_latency: stats.latency,
                    meta_native_tokens_prompt: stats.native_tokens_prompt,
                    meta_native_tokens_completion: stats.native_tokens_completion,
                    meta_native_tokens_reasoning: stats.native_tokens_reasoning,
                    meta_native_tokens_cached: stats.native_tokens_cached,
                    meta_cache_discount: stats.cache_discount,
                    meta_usage: { cost: stats.usage }, // Store as JSONB
                    meta_finish_reason: stats.finish_reason,
                    meta_provider_name: stats.provider_name
                })
                .eq('id', messageId);

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: 'Failed to update message stats', error, meta: { messageId } });
            } else {
                logger.debug({ kind: 'infra', component: COMPONENT, message: 'Message stats updated', meta: { messageId, usage: stats.usage } });
            }
        } catch (err) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during stats update', error: err });
        }
    }
}
