/**
 * 充值业务规则 (Layer 3 Domain)
 * 职责：定义星尘套餐、积分换算、订单号生成
 */

import { runtimeConfig } from '../../../infrastructure/runtime_config/RuntimeConfigService.js';
import type { CreditsPlan } from '../../../types/payment.js';

/** 从 runtime_config 读取套餐映射表 */
export async function getCreditsPlans(): Promise<CreditsPlan[]> {
    return runtimeConfig.getPaymentCreditsPlans();
}

/** 根据星尘数量查找对应套餐 */
export async function findPlanByCredits(credits: number): Promise<CreditsPlan | undefined> {
    const plans = await getCreditsPlans();
    return plans.find(p => p.credits === credits);
}

/** 根据人民币金额查找对应套餐 */
export async function findPlanByPrice(priceCNY: number): Promise<CreditsPlan | undefined> {
    const plans = await getCreditsPlans();
    return plans.find(p => p.priceCNY === priceCNY);
}

/**
 * 计算充值获得的积分（基于套餐映射表）
 * @param amountCNY 充值金额（人民币）
 * @returns mainCredits = 套餐对应的星尘数，bonusCredits 固定为 0（赠送已包含在套餐定价中）
 */
export async function calculateCreditsFromRecharge(amountCNY: number): Promise<{
    mainCredits: number;
    bonusCredits: number;
}> {
    const plan = await findPlanByPrice(amountCNY);
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
