/**
 * 充值业务规则 (Layer 3 Domain)
 * 职责：定义充值金额档位、积分转换比例、赠送规则
 */

/** 充值金额档位（人民币） */
export const RECHARGE_AMOUNTS = [1, 5, 10, 20, 50, 100, 200, 500] as const;
export type RechargeAmount = typeof RECHARGE_AMOUNTS[number];

/** 人民币 → 积分 转换比例（1元 = 100积分） */
const CNY_TO_CREDITS_RATIO = 100;

/**
 * 充值赠送规则（阶梯式）
 * 充值金额达到阈值时，按比例赠送额外积分
 */
const BONUS_RULES: { threshold: number; bonusPercent: number }[] = [
    { threshold: 100, bonusPercent: 5 },   // 充100送5%
    { threshold: 200, bonusPercent: 10 },  // 充200送10%
    { threshold: 500, bonusPercent: 15 },  // 充500送15%
];

/**
 * 计算充值获得的积分
 * @param amountCNY 充值金额（人民币）
 * @returns 主账户积分 + 赠送积分
 */
export function calculateCreditsFromRecharge(amountCNY: number): {
    mainCredits: number;
    bonusCredits: number;
    bonusPercent: number;
} {
    const mainCredits = Math.floor(amountCNY * CNY_TO_CREDITS_RATIO);

    let bonusPercent = 0;
    for (const rule of BONUS_RULES) {
        if (amountCNY >= rule.threshold) {
            bonusPercent = rule.bonusPercent;
        }
    }

    const bonusCredits = Math.floor(mainCredits * bonusPercent / 100);

    return { mainCredits, bonusCredits, bonusPercent };
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

/**
 * 获取充值说明文案
 */
export function getRechargeDescription(amountCNY: number): string {
    const { mainCredits, bonusCredits, bonusPercent } = calculateCreditsFromRecharge(amountCNY);

    let description = `充值 ¥${amountCNY} → 获得 ${formatCredits(mainCredits)}`;

    if (bonusCredits > 0) {
        description += `\n🎁 额外赠送 ${bonusPercent}%：${formatCredits(bonusCredits)}`;
        description += `\n✨ 共计：${formatCredits(mainCredits + bonusCredits)}`;
    }

    return description;
}
