import { supabase } from '../supabase/SupabaseClient.js';
import type { ICreditsRepository, CreditBalance } from '../../features/credits/ports/ICreditsRepository.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseCreditRepo';

/**
 * Layer D: Infrastructure - 使用 Supabase 实现积分读写
 *
 * 设计约束（"bot 不依赖积分系统"）：
 * - 每个方法内部自行兜底，永远不向外抛异常
 * - getBalance 失败返回 null，deductCredits 失败返回 false
 */
export class SupabaseCreditRepository implements ICreditsRepository {

    async getBalance(userId: string): Promise<CreditBalance | null> {
        if (!supabase) return null;

        try {
            const { data, error } = await supabase
                .from('bot_users')
                .select('main_credits, bonus_credits')
                .eq('user_id', userId)
                .single();

            if (error || !data) {
                logger.warn({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Failed to query credits',
                    meta: { userId, error: error?.message },
                });
                return null;
            }

            return {
                mainCredits: data.main_credits ?? 0,
                bonusCredits: data.bonus_credits ?? 0,
            };
        } catch (err) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Exception querying credits',
                error: err,
                meta: { userId },
            });
            return null;
        }
    }

    async deductCredits(userId: string, amount: number): Promise<boolean> {
        if (!supabase) return false;

        try {
            const { data, error } = await supabase.rpc('deduct_credits', {
                p_user_id: userId,
                p_amount: amount,
            });

            if (error) {
                logger.error({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'deduct_credits RPC failed',
                    error,
                    meta: { userId, amount },
                });
                return false;
            }

            return data === true;
        } catch (err) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Exception during credit deduction',
                error: err,
                meta: { userId, amount },
            });
            return false;
        }
    }
}
