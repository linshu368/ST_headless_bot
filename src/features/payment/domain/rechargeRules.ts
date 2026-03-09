/**
 * 充值业务规则 (Layer 3 Domain)
 * 职责：定义星尘套餐、积分换算、订单号生成
 */

import config from '../../../platform/config.js';

/** 星尘套餐定义 */
export interface CreditsPlan {
    credits: number;   // 星尘数量（展示给用户）
    priceCNY: number;  // 实际支付金额（人民币）
}

/** 从 config 读取套餐映射表，方便后续迁移至 runtime_config */
export function getCreditsPlans(): CreditsPlan[] {
    return config.payment.creditsPlans;
}

/** 根据星尘数量查找对应套餐 */
export function findPlanByCredits(credits: number): CreditsPlan | undefined {
    return getCreditsPlans().find(p => p.credits === credits);
}

/** 根据人民币金额查找对应套餐 */
export function findPlanByPrice(priceCNY: number): CreditsPlan | undefined {
    return getCreditsPlans().find(p => p.priceCNY === priceCNY);
}

/**
 * 计算充值获得的积分（基于套餐映射表）
 * @param amountCNY 充值金额（人民币）
 * @returns mainCredits = 套餐对应的星尘数，bonusCredits 固定为 0（赠送已包含在套餐定价中）
 */
export function calculateCreditsFromRecharge(amountCNY: number): {
    mainCredits: number;
    bonusCredits: number;
} {
    const plan = findPlanByPrice(amountCNY);
    if (plan) {
        return { mainCredits: plan.credits, bonusCredits: 0 };
    }
    // fallback: 未匹配套餐时不发放积分，由调用方处理
    return { mainCredits: 0, bonusCredits: 0 };
}

/**
 * 生成订单号
 * 格式: TG_{userId}_{timestamp}_{random}
 */
export function generateOrderNo(userId: string): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `TG_${userId}_${timestamp}_${random}`;
}

/**
 * 格式化积分显示
 * @param credits 积分数量
 * @returns 格式化字符串（如 "1,000 星尘"）
 */
export function formatCredits(credits: number): string {
    return credits.toLocaleString('zh-CN') + ' 星尘';
}
