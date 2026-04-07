/**
 * Layer C: Port - 签到存储的需求声明
 * 声明对签到数据读写的能力需求，不关心底层实现
 */

/** 原子签到操作的返回结果 */
export interface CheckinOperationResult {
    /** 签到是否成功（false = 冷却中或系统异常） */
    success: boolean;
    /** 失败时的具体原因 */
    reason?: 'cooldown' | 'system_error';
}

/** 签到流水明细（来自 checkin_logs 表） */
export interface CheckinLogEntry {
    reward: number;
    checkedInAt: Date;
}

export interface ICheckinRepository {
    /**
     * 查询用户最后一次签到时间
     * @returns 最后签到时间；从未签到返回 null；系统异常返回 undefined
     */
    getLastCheckinTime(userId: string): Promise<Date | null | undefined>;

    /**
     * 原子化签到：在数据库事务中检查冷却 + 更新签到时间 + 发放 bonus 积分 + 写入流水
     * 由 DB 层 RPC 保证并发安全
     * @param userId 用户 ID
     * @param reward 发放的 bonus_credits 数量
     */
    performCheckin(userId: string, reward: number): Promise<CheckinOperationResult>;

    /**
     * 查询用户签到历史流水
     * @param userId 用户 ID
     * @param limit 返回条数，默认 30
     * @returns 签到记录数组（按时间倒序）；异常时返回空数组
     */
    getCheckinHistory(userId: string, limit?: number): Promise<CheckinLogEntry[]>;
}
