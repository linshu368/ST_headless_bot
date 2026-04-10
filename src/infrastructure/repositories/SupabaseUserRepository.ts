import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';
import type { UserPreferences } from '../../features/chat/domain/UserPreferences.js';

const COMPONENT = 'SupabaseUserRepository';

export interface TelegramUserUpsert {
    userId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    source?: string;
}

/**
 * Layer D: Adapter - 使用 Supabase 实现用户表写入
 *
 * Notes:
 * - 依赖约束：`bot_users.user_id` 为 NOT NULL 且 UNIQUE（你已添加）。
 * - 写入策略：按 user_id upsert，保证幂等。
 */
export class SupabaseUserRepository {
    async upsertTelegramUser(input: TelegramUserUpsert): Promise<void> {
        if (!supabase) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Supabase client not initialized, skipping user upsert' });
            return;
        }

        const userId = input.userId;
        if (!userId) return;

        const payload: Record<string, unknown> = {
            user_id: userId,
            tg_username: input.username ?? null,
            tg_first_name: input.firstName ?? null,
            tg_last_name: input.lastName ?? null,
            updated_at: new Date().toISOString(),
        };

        try {
            let isNewUser = false;

            if (input.source) {
                const { data: existing } = await supabase
                    .from('bot_users')
                    .select('user_id')
                    .eq('user_id', userId)
                    .maybeSingle();

                if (!existing) {
                    payload.source_id = input.source;
                    isNewUser = true;
                }
            }

            const { error } = await supabase
                .from('bot_users')
                .upsert(payload, { onConflict: 'user_id' });

            if (error) {
                logger.error({
                    kind: 'infra',
                    component: COMPONENT,
                    message: `Failed to upsert bot user: ${error.message} (code: ${error.code})`,
                    meta: { hint: error.hint, details: error.details, userId },
                });
            } else if (isNewUser) {
                logger.info({ kind: 'biz', component: COMPONENT, message: 'New user acquired via channel link', meta: { userId, sourceId: input.source } });
                await this.recordTrafficClick(input.source!);
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during bot user upsert', error, meta: { userId } });
        }
    }

    private async recordTrafficClick(sourceId: string): Promise<void> {
        if (!supabase) return;

        try {
            const { error } = await supabase.rpc('increment_click', {
                p_source_id: sourceId,
            });

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: `Failed to record traffic click: ${error.message}`,
                    meta: { sourceId },
                });
            } else {
                logger.info({ kind: 'biz', component: COMPONENT, message: 'Traffic click recorded', meta: { sourceId } });
            }
        } catch (error) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception during traffic click recording',
                error, meta: { sourceId },
            });
        }
    }

    async incrementTotalRound(userId: string): Promise<void> {
        if (!supabase) return;

        try {
            const { error } = await supabase.rpc('increment_total_round', { target_user_id: userId });

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: 'Failed to increment total_round', error, meta: { userId } });
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during total_round increment', error, meta: { userId } });
        }
    }

    /**
     * 将用户偏好持久化到 bot_users 表（三个独立字段）。
     * 
     * 调用时机：用户通过 Telegram UI 修改偏好后，fire-and-forget 写入。
     * 运行时不从此表读取——Redis 是运行时唯一数据源。
     */
    async updatePreferences(userId: string, preferences: UserPreferences): Promise<void> {
        if (!supabase) return;

        try {
            const { error } = await supabase
                .from('bot_users')
                .update({
                    pref_word_count: preferences.word_count,
                    pref_show_options: preferences.show_options,
                    pref_custom_instructions: preferences.custom_instructions || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('user_id', userId);

            if (error) {
                logger.error({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Failed to update user preferences',
                    error,
                    meta: { userId },
                });
            } else {
                logger.debug({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'User preferences persisted to bot_users',
                    meta: { userId, word_count: preferences.word_count, show_options: preferences.show_options },
                });
            }
        } catch (error) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Exception during preferences update',
                error,
                meta: { userId },
            });
        }
    }
}