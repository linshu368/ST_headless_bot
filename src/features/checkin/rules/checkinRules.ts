/**
 * Layer A: Domain Rules - 签到业务规则
 * 纯函数，不涉及 IO
 */

/** 签到奖励（星尘），计入 bonus_credits */
export const CHECKIN_REWARD = 60;

/** 签到冷却时间（毫秒）：24 小时 */
export const CHECKIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 判断用户当前是否可以签到
 * @param lastCheckinAt 上次签到时间，null 表示从未签到
 * @param now 当前时间（便于测试注入）
 */
export function canCheckIn(lastCheckinAt: Date | null, now: Date = new Date()): boolean {
    if (!lastCheckinAt) return true;
    return now.getTime() - lastCheckinAt.getTime() >= CHECKIN_COOLDOWN_MS;
}

/**
 * 计算下次可签到的时间
 * @param lastCheckinAt 上次签到时间
 */
export function getNextCheckinTime(lastCheckinAt: Date): Date {
    return new Date(lastCheckinAt.getTime() + CHECKIN_COOLDOWN_MS);
}

/**
 * 计算距离下次可签到还剩多少时间（人类可读）
 * @param lastCheckinAt 上次签到时间
 * @param now 当前时间（便于测试注入）
 */
export function getRemainingCooldown(lastCheckinAt: Date, now: Date = new Date()): string {
    const nextTime = getNextCheckinTime(lastCheckinAt);
    const diffMs = nextTime.getTime() - now.getTime();

    if (diffMs <= 0) return '0分钟';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.ceil((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${minutes}分钟`;
}
