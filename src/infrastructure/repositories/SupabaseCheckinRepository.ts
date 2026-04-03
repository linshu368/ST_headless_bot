import { supabase } from '../supabase/SupabaseClient.js';
import type { ICheckinRepository, CheckinOperationResult } from '../../features/checkin/ports/ICheckinRepository.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseCheckinRepo';

/**
 * Layer D: Infrastructure - 使用 Supabase 实现签到存储
 *
 * 设计约束（与 SupabaseCreditRepository 一致）：
 * - 每个方法内部自行兜底，永远不向外抛异常
 * - getLastCheckinTime 失败返回 undefined（区别于"从未签到"的 null）
 * - performCheckin 通过 DB RPC 保证原子性和并发安全
 */
export class SupabaseCheckinRepository implements ICheckinRepository {

    async getLastCheckinTime(userId: string): Promise<Date | null | undefined> {
        if (!supabase) return undefined;

        try {
            const { data, error } = await supabase
                .from('bot_users')
                .select('last_checkin_at')
                .eq('user_id', userId)
                .single();

            if (error || !data) {
                logger.warn({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Failed to query last_checkin_at',
                    meta: { userId, error: error?.message },
                });
                return undefined;
            }

            return data.last_checkin_at ? new Date(data.last_checkin_at) : null;
        } catch (err) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Exception querying last_checkin_at',
                error: err,
                meta: { userId },
            });
            return undefined;
        }
    }

    /**
     * 调用 Supabase RPC `daily_checkin` 执行原子签到
     *
     * RPC 预期行为：
     * 1. 检查 last_checkin_at 距 now() 是否 >= 24h
     * 2. 若冷却中 → 返回 { success: false, reason: 'cooldown' }
     * 3. 若可签到 → UPDATE last_checkin_at = now(), bonus_credits += p_reward
     *    → 返回 { success: true }
     */
    async performCheckin(userId: string, reward: number): Promise<CheckinOperationResult> {
        if (!supabase) {
            return { success: false, reason: 'system_error' };
        }

        try {
            const { data, error } = await supabase.rpc('daily_checkin', {
                p_user_id: userId,
                p_reward: reward,
            });

            if (error) {
                logger.error({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'daily_checkin RPC failed',
                    error,
                    meta: { userId, reward },
                });
                return { success: false, reason: 'system_error' };
            }

            if (data && typeof data === 'object' && data.success === true) {
                logger.info({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Checkin succeeded via RPC',
                    meta: { userId, reward },
                });
                return { success: true };
            }

            if (data && typeof data === 'object' && data.reason === 'cooldown') {
                return { success: false, reason: 'cooldown' };
            }

            logger.warn({
                kind: 'infra',
                component: COMPONENT,
                message: 'daily_checkin RPC returned unexpected value',
                meta: { userId, reward, data },
            });
            return { success: false, reason: 'system_error' };
        } catch (err) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Exception during daily_checkin RPC',
                error: err,
                meta: { userId, reward },
            });
            return { success: false, reason: 'system_error' };
        }
    }
}
