import { logger } from '../../../platform/logger.js';
import type { ICheckinRepository } from '../ports/ICheckinRepository.js';
import { canCheckIn, getNextCheckinTime, getRemainingCooldown, CHECKIN_REWARD } from '../rules/checkinRules.js';

const COMPONENT = 'CheckinUseCase';

/** 签到成功 */
export interface CheckinSuccess {
    success: true;
    reward: number;
}

/** 签到失败：冷却中 */
export interface CheckinCooldown {
    success: false;
    reason: 'cooldown';
    nextCheckinTime: Date;
    remaining: string;
}

/** 签到失败：系统异常 */
export interface CheckinSystemError {
    success: false;
    reason: 'system_error';
}

export type CheckinResult = CheckinSuccess | CheckinCooldown | CheckinSystemError;

/**
 * Layer 2: UseCase - 签到用例
 * 协调 rules 与 repository，实现签到流程
 */
export class CheckinUseCase {
    private repo: ICheckinRepository;

    constructor(repo: ICheckinRepository) {
        this.repo = repo;
    }

    async checkin(userId: string): Promise<CheckinResult> {
        // 1. 快速预检：查询上次签到时间
        const lastCheckinAt = await this.repo.getLastCheckinTime(userId);

        // undefined = 系统异常，放弃预检，仍尝试 RPC（由 DB 层兜底）
        if (lastCheckinAt !== undefined) {
            if (!canCheckIn(lastCheckinAt)) {
                const nextTime = getNextCheckinTime(lastCheckinAt!);
                const remaining = getRemainingCooldown(lastCheckinAt!);

                logger.info({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'Checkin rejected: cooldown',
                    meta: { userId, lastCheckinAt: lastCheckinAt!.toISOString(), remaining },
                });

                return { success: false, reason: 'cooldown', nextCheckinTime: nextTime, remaining };
            }
        }

        // 2. 执行原子签到（DB 层再次校验冷却，防并发）
        const result = await this.repo.performCheckin(userId, CHECKIN_REWARD);

        if (result.success) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'Checkin succeeded',
                meta: { userId, reward: CHECKIN_REWARD },
            });
            return { success: true, reward: CHECKIN_REWARD };
        }

        // RPC 层返回冷却（并发场景：预检通过但 RPC 拒绝）
        if (result.reason === 'cooldown') {
            const freshLastCheckin = await this.repo.getLastCheckinTime(userId);
            const now = new Date();

            if (freshLastCheckin) {
                return {
                    success: false,
                    reason: 'cooldown',
                    nextCheckinTime: getNextCheckinTime(freshLastCheckin),
                    remaining: getRemainingCooldown(freshLastCheckin, now),
                };
            }

            return { success: false, reason: 'cooldown', nextCheckinTime: now, remaining: '0分钟' };
        }

        logger.error({
            kind: 'biz',
            component: COMPONENT,
            message: 'Checkin failed: system error',
            meta: { userId },
        });

        return { success: false, reason: 'system_error' };
    }
}
