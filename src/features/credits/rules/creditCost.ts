/**
 * Layer A: Domain Rules - 积分费率与判定
 * 纯业务规则，不涉及 IO
 */

import { ModelTier } from '../../chat/domain/ModelStrategy.js';

// ============ 费率表（静态 fallback，运行时由 ai_config_source.tier_costs 覆盖） ============

const TIER_COST: Record<ModelTier, number> = {
    [ModelTier.TIER_1]: 5,
    [ModelTier.TIER_2]: 10,
    [ModelTier.TIER_3]: 12,
    [ModelTier.TIER_4]: 28,
};

// ============ 纯函数 ============

/** 查询指定模型等级的单次对话扣费额；传入动态费率表时优先使用 */
export function getCostForTier(tier: ModelTier, dynamicCosts?: Record<string, number>): number {
    if (dynamicCosts && tier in dynamicCosts) {
        return dynamicCosts[tier];
    }
    return TIER_COST[tier] ?? TIER_COST[ModelTier.TIER_3];
}

/**
 * 合并两种余额为用户可见的总余额
 * bonus_credits: 赠送余额（签到、新用户、拉新等）
 * main_credits:  充值余额（用户付费购买）
 */
export function getTotalBalance(bonusCredits: number, mainCredits: number): number {
    return bonusCredits + mainCredits;
}

/** 判断总余额是否足够支付一次指定等级的对话 */
export function hasEnoughCredits(totalBalance: number, tier: ModelTier, dynamicCosts?: Record<string, number>): boolean {
    return totalBalance >= getCostForTier(tier, dynamicCosts);
}

// ============ 类型化错误 ============

/**
 * 余额不足错误
 * 由 Usecase 层抛出，Adapter 层捕获并展示 UI
 */
export class InsufficientCreditsError extends Error {
    public readonly balance: number;

    constructor(balance: number) {
        super('Insufficient credits');
        this.name = 'InsufficientCreditsError';
        this.balance = balance;
    }
}
