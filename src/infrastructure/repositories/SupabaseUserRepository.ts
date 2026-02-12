import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseUserRepository';

export interface TelegramUserUpsert {
    userId: string; // telegram chatId as string (current system user_id)
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
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

        const payload = {
            user_id: userId,
            tg_username: input.username ?? null,
            tg_first_name: input.firstName ?? null,
            tg_last_name: input.lastName ?? null,
            updated_at: new Date().toISOString(),
        };

        try {
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
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception during bot user upsert', error, meta: { userId } });
        }
    }
}

