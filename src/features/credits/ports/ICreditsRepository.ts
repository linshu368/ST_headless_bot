/**
 * Layer C: Port - 积分存储的需求声明
 * 声明对积分读写的能力需求，不关心底层实现
 */

/** 用户余额快照（双账户结构） */
export interface CreditBalance {
    /** 充值余额（用户付费购买） */
    mainCredits: number;
    /** 赠送余额（签到、新用户、拉新等） */
    bonusCredits: number;
}

/** 单次扣费明细（由 RPC 原子返回，不可伪造） */
export interface DeductionResult {
    /** 从 main_credits 实际扣除的数量 */
    mainDeducted: number;
    /** 从 bonus_credits 实际扣除的数量 */
    bonusDeducted: number;
}

export interface ICreditsRepository {
    /**
     * 查询用户余额
     * @returns 余额快照；积分系统不可用时返回 null（调用方据此放行）
     */
    getBalance(userId: string): Promise<CreditBalance | null>;

    /**
     * 原子扣减积分（优先扣 main，不足部分从 bonus 扣）
     * 扣减顺序由基础设施层的 RPC 保证
     * @returns 扣费明细；余额不足或系统异常返回 null
     */
    deductCredits(userId: string, amount: number): Promise<DeductionResult | null>;

    /**
     * 充值积分（支付成功后调用）
     * @param userId 用户ID
     * @param mainCredits 充值积分（计入 main_credits）
     * @param bonusCredits 赠送积分（计入 bonus_credits）
     * @param paidAmount 本次实付金额（CNY），用于更新付费统计字段；非付费场景传 0 或省略
     * @returns true=充值成功, false=系统异常
     */
    addCredits(userId: string, mainCredits: number, bonusCredits: number, paidAmount?: number): Promise<boolean>;
}
