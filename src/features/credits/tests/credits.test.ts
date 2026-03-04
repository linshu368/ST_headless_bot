/**
 * Credits System Test Suite (Steps 1–5)
 *
 * Part A: Pure function tests (creditCost.ts) — 无依赖，始终运行
 * Part B: Infrastructure tests (SupabaseCreditRepository) — 需要 Supabase 连接
 * Part C: Integration logic tests — 模拟 SimpleChat 的积分决策逻辑
 *
 * 运行方式: cd SillyTavern && node --loader ts-node/esm src/features/credits/tests/credits.test.ts
 */

import assert from 'node:assert/strict';
import { ModelTier } from '../../chat/domain/ModelStrategy.js';
import {
    getCostForTier,
    getTotalBalance,
    hasEnoughCredits,
    InsufficientCreditsError,
} from '../rules/creditCost.js';
import { SupabaseCreditRepository } from '../../../infrastructure/repositories/SupabaseCreditRepository.js';
import type { ICreditsRepository, CreditBalance } from '../ports/ICreditsRepository.js';

// ============================================================
// Test Runner
// ============================================================

type TestCase = { name: string; fn: () => Promise<void> };
const results = { passed: 0, failed: 0, skipped: 0 };

async function runSuite(title: string, tests: TestCase[]): Promise<void> {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  ${title}`);
    console.log('='.repeat(50));
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
            results.passed++;
        } catch (err: any) {
            if (err?.message === '__SKIP__') {
                console.log(`  ⊘ ${t.name} (SKIPPED)`);
                results.skipped++;
            } else {
                console.log(`  ✗ ${t.name}`);
                console.error(`    ${err?.message || err}`);
                results.failed++;
            }
        }
    }
}

function skip(reason?: string): never {
    const err = new Error('__SKIP__');
    throw err;
}

// ============================================================
// Part A: Pure Function Tests (creditCost.ts)
// ============================================================

const partA: TestCase[] = [
    {
        name: 'getCostForTier: TIER_1 → 1',
        fn: async () => {
            assert.equal(getCostForTier(ModelTier.TIER_1), 1);
        },
    },
    {
        name: 'getCostForTier: TIER_2 → 2',
        fn: async () => {
            assert.equal(getCostForTier(ModelTier.TIER_2), 2);
        },
    },
    {
        name: 'getCostForTier: TIER_3 → 5',
        fn: async () => {
            assert.equal(getCostForTier(ModelTier.TIER_3), 5);
        },
    },
    {
        name: 'getCostForTier: TIER_4 → 10',
        fn: async () => {
            assert.equal(getCostForTier(ModelTier.TIER_4), 10);
        },
    },
    {
        name: 'getCostForTier: unknown tier fallback → 5 (TIER_3)',
        fn: async () => {
            assert.equal(getCostForTier('tier_unknown' as ModelTier), 5);
        },
    },
    {
        name: 'getTotalBalance: 9999 + 0 = 9999',
        fn: async () => {
            assert.equal(getTotalBalance(0, 9999), 9999);
        },
    },
    {
        name: 'getTotalBalance: 100 + 200 = 300',
        fn: async () => {
            assert.equal(getTotalBalance(100, 200), 300);
        },
    },
    {
        name: 'getTotalBalance: 0 + 0 = 0',
        fn: async () => {
            assert.equal(getTotalBalance(0, 0), 0);
        },
    },
    {
        name: 'hasEnoughCredits: 余额刚好等于费用 → true',
        fn: async () => {
            const cost = getCostForTier(ModelTier.TIER_3); // 5
            assert.equal(hasEnoughCredits(cost, ModelTier.TIER_3), true);
        },
    },
    {
        name: 'hasEnoughCredits: 余额比费用多 1 → true',
        fn: async () => {
            const cost = getCostForTier(ModelTier.TIER_3); // 5
            assert.equal(hasEnoughCredits(cost + 1, ModelTier.TIER_3), true);
        },
    },
    {
        name: 'hasEnoughCredits: 余额比费用少 1 → false',
        fn: async () => {
            const cost = getCostForTier(ModelTier.TIER_3); // 5
            assert.equal(hasEnoughCredits(cost - 1, ModelTier.TIER_3), false);
        },
    },
    {
        name: 'hasEnoughCredits: 余额为 0 → false (任意 tier)',
        fn: async () => {
            assert.equal(hasEnoughCredits(0, ModelTier.TIER_1), false);
            assert.equal(hasEnoughCredits(0, ModelTier.TIER_4), false);
        },
    },
    {
        name: 'hasEnoughCredits: 余额 1 对 TIER_1 (费用 1) → true',
        fn: async () => {
            assert.equal(hasEnoughCredits(1, ModelTier.TIER_1), true);
        },
    },
    {
        name: 'hasEnoughCredits: 余额 1 对 TIER_2 (费用 2) → false',
        fn: async () => {
            assert.equal(hasEnoughCredits(1, ModelTier.TIER_2), false);
        },
    },
    {
        name: 'InsufficientCreditsError: 构造正确',
        fn: async () => {
            const err = new InsufficientCreditsError(42);
            assert.equal(err instanceof Error, true);
            assert.equal(err instanceof InsufficientCreditsError, true);
            assert.equal(err.name, 'InsufficientCreditsError');
            assert.equal(err.balance, 42);
            assert.equal(err.message, 'Insufficient credits');
        },
    },
    {
        name: 'InsufficientCreditsError: 可被 instanceof 捕获',
        fn: async () => {
            try {
                throw new InsufficientCreditsError(0);
            } catch (e) {
                assert.equal(e instanceof InsufficientCreditsError, true);
                if (e instanceof InsufficientCreditsError) {
                    assert.equal(e.balance, 0);
                }
            }
        },
    },
];

// ============================================================
// Part B: Infrastructure Tests (SupabaseCreditRepository)
// ============================================================

function createPartB(): TestCase[] {
    const repo = new SupabaseCreditRepository();

    // 用环境变量指定测试用户，默认用一个不太可能冲突的 ID
    const TEST_USER = process.env.CREDITS_TEST_USER_ID || '7116726082';

    return [
        {
            name: 'getBalance: 返回 CreditBalance 结构（非 null）',
            fn: async () => {
                if (!TEST_USER) skip();
                const balance = await repo.getBalance(TEST_USER);
                if (balance === null) {
                    // Supabase 未配置或用户不存在 → 跳过而非失败
                    skip();
                }
                assert.equal(typeof balance!.mainCredits, 'number');
                assert.equal(typeof balance!.bonusCredits, 'number');
                assert.ok(balance!.mainCredits >= 0, 'mainCredits should be >= 0');
                assert.ok(balance!.bonusCredits >= 0, 'bonusCredits should be >= 0');
                console.log(`    → main=${balance!.mainCredits}, bonus=${balance!.bonusCredits}`);
            },
        },
        {
            name: 'getBalance: 不存在的用户 → 返回 null',
            fn: async () => {
                if (!TEST_USER) skip();
                const balance = await repo.getBalance('nonexistent_user_id_99999');
                assert.equal(balance, null);
            },
        },
        {
            name: 'deductCredits: 扣 1 积分成功 → true',
            fn: async () => {
                if (!TEST_USER) skip();
                const before = await repo.getBalance(TEST_USER);
                if (!before) skip();

                const totalBefore = before!.mainCredits + before!.bonusCredits;
                if (totalBefore < 1) skip(); // 余额不够测试

                const ok = await repo.deductCredits(TEST_USER, 1);
                assert.equal(ok, true);

                const after = await repo.getBalance(TEST_USER);
                assert.ok(after, 'balance should exist after deduction');
                const totalAfter = after!.mainCredits + after!.bonusCredits;
                assert.equal(totalAfter, totalBefore - 1, `expected ${totalBefore - 1}, got ${totalAfter}`);
                console.log(`    → before=${totalBefore}, after=${totalAfter}`);
            },
        },
        {
            name: 'deductCredits: 扣除优先级验证 (main 先扣)',
            fn: async () => {
                if (!TEST_USER) skip();
                const before = await repo.getBalance(TEST_USER);
                if (!before || before.mainCredits < 1) skip();

                const mainBefore = before!.mainCredits;
                const bonusBefore = before!.bonusCredits;

                const ok = await repo.deductCredits(TEST_USER, 1);
                assert.equal(ok, true);

                const after = await repo.getBalance(TEST_USER);
                assert.ok(after);
                // main 应该减少（因为 main 有余额时优先扣 main）
                assert.equal(after!.mainCredits, mainBefore - 1, 'main should decrease first');
                assert.equal(after!.bonusCredits, bonusBefore, 'bonus should stay unchanged');
                console.log(`    → main: ${mainBefore} → ${after!.mainCredits}, bonus: ${bonusBefore} → ${after!.bonusCredits}`);
            },
        },
        {
            name: 'deductCredits: 超额扣除 → false（余额不变）',
            fn: async () => {
                if (!TEST_USER) skip();
                const before = await repo.getBalance(TEST_USER);
                if (!before) skip();

                const totalBefore = before!.mainCredits + before!.bonusCredits;
                const ok = await repo.deductCredits(TEST_USER, totalBefore + 9999);
                assert.equal(ok, false);

                const after = await repo.getBalance(TEST_USER);
                assert.ok(after);
                const totalAfter = after!.mainCredits + after!.bonusCredits;
                assert.equal(totalAfter, totalBefore, 'balance should be unchanged after failed deduction');
            },
        },
        {
            name: 'deductCredits: 不存在的用户 → false',
            fn: async () => {
                if (!TEST_USER) skip();
                const ok = await repo.deductCredits('nonexistent_user_id_99999', 1);
                assert.equal(ok, false);
            },
        },
    ];
}

// ============================================================
// Part C: Integration Logic Tests (模拟 SimpleChat 决策)
// ============================================================

/** Mock: 正常返回余额 */
class MockCreditsRepo implements ICreditsRepository {
    private main: number;
    private bonus: number;
    public deductCalled = false;
    public lastDeductAmount = 0;

    constructor(main: number, bonus: number) {
        this.main = main;
        this.bonus = bonus;
    }

    async getBalance(_userId: string): Promise<CreditBalance | null> {
        return { mainCredits: this.main, bonusCredits: this.bonus };
    }

    async deductCredits(_userId: string, amount: number): Promise<boolean> {
        this.deductCalled = true;
        this.lastDeductAmount = amount;
        const total = this.main + this.bonus;
        if (total < amount) return false;
        this.main = Math.max(0, this.main - amount);
        if (amount > this.main + amount) {
            // already handled above
        }
        return true;
    }
}

/** Mock: 模拟积分系统故障（getBalance 返回 null） */
class FailingCreditsRepo implements ICreditsRepository {
    async getBalance(_userId: string): Promise<CreditBalance | null> {
        return null;
    }
    async deductCredits(_userId: string, _amount: number): Promise<boolean> {
        return false;
    }
}

/**
 * 模拟 SimpleChat._executeStreamGeneration 中的积分决策逻辑
 * 不启动真实引擎，只测试决策分支
 */
async function simulateCreditDecision(
    creditsRepository: ICreditsRepository | null,
    userId: string,
    userMode: string,
    streamCompleted: boolean,
): Promise<{
    preCheckResult: 'pass' | 'insufficient' | 'skipped';
    deductResult: 'deducted' | 'skipped_not_completed' | 'skipped_no_repo';
}> {
    const { resolveTierFromMode } = await import('../../chat/domain/ModelStrategy.js');

    // --- Pre-check (mirrors SimpleChat Promise.all + check) ---
    let creditBalance: CreditBalance | null = null;
    try {
        creditBalance = await (creditsRepository?.getBalance(userId).catch(() => null) ?? Promise.resolve(null));
    } catch {
        creditBalance = null;
    }

    let preCheckResult: 'pass' | 'insufficient' | 'skipped';
    if (creditBalance !== null) {
        const tier = resolveTierFromMode(userMode);
        const total = getTotalBalance(creditBalance.mainCredits, creditBalance.bonusCredits);
        if (!hasEnoughCredits(total, tier)) {
            preCheckResult = 'insufficient';
            return { preCheckResult, deductResult: 'skipped_no_repo' };
        }
        preCheckResult = 'pass';
    } else {
        preCheckResult = 'skipped';
    }

    // --- Post-generation deduction (mirrors SimpleChat fire-and-forget) ---
    let deductResult: 'deducted' | 'skipped_not_completed' | 'skipped_no_repo';
    if (streamCompleted && creditsRepository) {
        const tier = resolveTierFromMode(userMode);
        const cost = getCostForTier(tier);
        const ok = await creditsRepository.deductCredits(userId, cost);
        deductResult = ok ? 'deducted' : 'skipped_no_repo';
    } else if (!streamCompleted) {
        deductResult = 'skipped_not_completed';
    } else {
        deductResult = 'skipped_no_repo';
    }

    return { preCheckResult, deductResult };
}

const partC: TestCase[] = [
    {
        name: '余额充足 + 流完整完成 → 预检通过 + 扣费',
        fn: async () => {
            const repo = new MockCreditsRepo(9999, 0);
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'pass');
            assert.equal(r.deductResult, 'deducted');
            assert.equal(repo.deductCalled, true);
            assert.equal(repo.lastDeductAmount, 5); // TIER_3 cost
        },
    },
    {
        name: '余额充足 + 流被截断 → 预检通过 + 不扣费',
        fn: async () => {
            const repo = new MockCreditsRepo(9999, 0);
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', false);
            assert.equal(r.preCheckResult, 'pass');
            assert.equal(r.deductResult, 'skipped_not_completed');
            assert.equal(repo.deductCalled, false);
        },
    },
    {
        name: '余额不足 → 预检拦截，不进入生成',
        fn: async () => {
            const repo = new MockCreditsRepo(2, 0); // total=2, TIER_3 costs 5
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'insufficient');
            assert.equal(repo.deductCalled, false);
        },
    },
    {
        name: '余额不足 (TIER_1) → 余额 0 → 拦截',
        fn: async () => {
            const repo = new MockCreditsRepo(0, 0);
            const r = await simulateCreditDecision(repo, 'u1', 'tier_1', true);
            assert.equal(r.preCheckResult, 'insufficient');
        },
    },
    {
        name: '余额刚好等于费用 → 预检通过 + 扣费',
        fn: async () => {
            const repo = new MockCreditsRepo(10, 0); // TIER_4 costs 10
            const r = await simulateCreditDecision(repo, 'u1', 'tier_4', true);
            assert.equal(r.preCheckResult, 'pass');
            assert.equal(r.deductResult, 'deducted');
            assert.equal(repo.lastDeductAmount, 10);
        },
    },
    {
        name: '积分系统不可用 (null repo) → 预检跳过 + 不扣费 + 对话正常',
        fn: async () => {
            const r = await simulateCreditDecision(null, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'skipped');
            assert.equal(r.deductResult, 'skipped_no_repo');
        },
    },
    {
        name: '积分系统故障 (getBalance → null) → 预检跳过 (放行) + 不扣费',
        fn: async () => {
            const repo = new FailingCreditsRepo();
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'skipped');
            // deductCredits returns false → mapped to skipped
            assert.equal(r.deductResult, 'skipped_no_repo');
        },
    },
    {
        name: 'TIER_1 扣费额正确 (1)',
        fn: async () => {
            const repo = new MockCreditsRepo(100, 0);
            await simulateCreditDecision(repo, 'u1', 'tier_1', true);
            assert.equal(repo.lastDeductAmount, 1);
        },
    },
    {
        name: 'TIER_2 扣费额正确 (2)',
        fn: async () => {
            const repo = new MockCreditsRepo(100, 0);
            await simulateCreditDecision(repo, 'u1', 'tier_2', true);
            assert.equal(repo.lastDeductAmount, 2);
        },
    },
    {
        name: 'bonus + main 混合余额判定：main=0, bonus=5 对 TIER_3 → 通过',
        fn: async () => {
            const repo = new MockCreditsRepo(0, 5);
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'pass');
        },
    },
    {
        name: 'bonus + main 混合余额判定：main=2, bonus=2 对 TIER_3 → 不足',
        fn: async () => {
            const repo = new MockCreditsRepo(2, 2); // total 4 < 5
            const r = await simulateCreditDecision(repo, 'u1', 'tier_3', true);
            assert.equal(r.preCheckResult, 'insufficient');
        },
    },
];

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    console.log('\n🧪 Credits System Test Suite (Steps 1–5)\n');

    await runSuite('Part A: Pure Functions (creditCost.ts)', partA);
    await runSuite('Part B: Infrastructure (SupabaseCreditRepository)', createPartB());
    await runSuite('Part C: Integration Logic (credit decision flow)', partC);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Results: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
    console.log('='.repeat(50));

    if (results.skipped > 0) {
        console.log('\n💡 Part B 需要真实 Supabase 连接和测试用户。');
        console.log('   设置环境变量后重新运行: CREDITS_TEST_USER_ID=<你的chatId>');
    }

    if (results.failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
