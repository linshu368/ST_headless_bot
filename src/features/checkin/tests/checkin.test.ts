/**
 * Checkin System Test Suite
 *
 * Part A: Pure function tests (checkinRules.ts) — 无依赖，始终运行
 * Part B: UseCase tests (CheckinUseCase) — 使用 Mock Repository
 *
 * 运行方式: cd SillyTavern && npx tsx src/features/checkin/tests/checkin.test.ts
 */

import assert from 'node:assert/strict';
import {
    canCheckIn,
    getNextCheckinTime,
    getRemainingCooldown,
    CHECKIN_REWARD,
    CHECKIN_COOLDOWN_MS,
} from '../rules/checkinRules.js';
import { CheckinUseCase } from '../usecases/CheckinUseCase.js';
import type { ICheckinRepository, CheckinOperationResult } from '../ports/ICheckinRepository.js';

// ============================================================
// Test Runner
// ============================================================

type TestCase = { name: string; fn: () => Promise<void> };
const results = { passed: 0, failed: 0 };

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
            console.log(`  ✗ ${t.name}`);
            console.error(`    ${err?.message || err}`);
            results.failed++;
        }
    }
}

// ============================================================
// Part A: Pure Function Tests (checkinRules.ts)
// ============================================================

const partA: TestCase[] = [
    {
        name: 'CHECKIN_REWARD = 60',
        fn: async () => {
            assert.equal(CHECKIN_REWARD, 60);
        },
    },
    {
        name: 'CHECKIN_COOLDOWN_MS = 86400000 (24h)',
        fn: async () => {
            assert.equal(CHECKIN_COOLDOWN_MS, 24 * 60 * 60 * 1000);
        },
    },
    {
        name: 'canCheckIn: 从未签到 (null) → true',
        fn: async () => {
            assert.equal(canCheckIn(null), true);
        },
    },
    {
        name: 'canCheckIn: 25小时前签到 → true',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - 25 * 60 * 60 * 1000);
            assert.equal(canCheckIn(last, now), true);
        },
    },
    {
        name: 'canCheckIn: 刚好24小时前签到 → true',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - CHECKIN_COOLDOWN_MS);
            assert.equal(canCheckIn(last, now), true);
        },
    },
    {
        name: 'canCheckIn: 23小时前签到 → false',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - 23 * 60 * 60 * 1000);
            assert.equal(canCheckIn(last, now), false);
        },
    },
    {
        name: 'canCheckIn: 1分钟前签到 → false',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - 60 * 1000);
            assert.equal(canCheckIn(last, now), false);
        },
    },
    {
        name: 'getNextCheckinTime: 正确计算下次签到时间',
        fn: async () => {
            const last = new Date('2025-01-01T10:00:00Z');
            const next = getNextCheckinTime(last);
            assert.equal(next.toISOString(), '2025-01-02T10:00:00.000Z');
        },
    },
    {
        name: 'getRemainingCooldown: 23小时前签到 → 约1小时',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - 23 * 60 * 60 * 1000);
            const remaining = getRemainingCooldown(last, now);
            assert.ok(remaining.includes('1小时'), `expected ~1小时, got "${remaining}"`);
        },
    },
    {
        name: 'getRemainingCooldown: 已过冷却 → 0分钟',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - 25 * 60 * 60 * 1000);
            assert.equal(getRemainingCooldown(last, now), '0分钟');
        },
    },
    {
        name: 'getRemainingCooldown: 23小时50分钟前 → 约10分钟',
        fn: async () => {
            const now = new Date();
            const last = new Date(now.getTime() - (23 * 60 + 50) * 60 * 1000);
            const remaining = getRemainingCooldown(last, now);
            assert.ok(remaining.includes('分钟'), `expected 分钟, got "${remaining}"`);
            assert.ok(!remaining.includes('小时'), `should not contain 小时, got "${remaining}"`);
        },
    },
];

// ============================================================
// Part B: UseCase Tests (CheckinUseCase + Mock Repository)
// ============================================================

class MockCheckinRepo implements ICheckinRepository {
    public lastCheckinAt: Date | null;
    public performCheckinResult: CheckinOperationResult;
    public performCheckinCalled = false;

    constructor(
        lastCheckinAt: Date | null = null,
        performCheckinResult: CheckinOperationResult = { success: true },
    ) {
        this.lastCheckinAt = lastCheckinAt;
        this.performCheckinResult = performCheckinResult;
    }

    async getLastCheckinTime(_userId: string): Promise<Date | null | undefined> {
        return this.lastCheckinAt;
    }

    async performCheckin(_userId: string, _reward: number): Promise<CheckinOperationResult> {
        this.performCheckinCalled = true;
        return this.performCheckinResult;
    }
}

class FailingCheckinRepo implements ICheckinRepository {
    async getLastCheckinTime(_userId: string): Promise<Date | null | undefined> {
        return undefined;
    }

    async performCheckin(_userId: string, _reward: number): Promise<CheckinOperationResult> {
        return { success: false, reason: 'system_error' };
    }
}

const partB: TestCase[] = [
    {
        name: '首次签到 → 成功，获得60星尘',
        fn: async () => {
            const repo = new MockCheckinRepo(null, { success: true });
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, true);
            if (result.success) {
                assert.equal(result.reward, 60);
            }
            assert.equal(repo.performCheckinCalled, true);
        },
    },
    {
        name: '冷却中签到 → 被预检拦截，不调用 RPC',
        fn: async () => {
            const recentCheckin = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2小时前
            const repo = new MockCheckinRepo(recentCheckin, { success: true });
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, false);
            if (!result.success) {
                assert.equal(result.reason, 'cooldown');
                assert.ok(result.remaining, 'should have remaining time');
                assert.ok(result.nextCheckinTime instanceof Date, 'should have nextCheckinTime');
            }
            assert.equal(repo.performCheckinCalled, false);
        },
    },
    {
        name: '冷却刚过 → 签到成功',
        fn: async () => {
            const justExpired = new Date(Date.now() - CHECKIN_COOLDOWN_MS - 1000);
            const repo = new MockCheckinRepo(justExpired, { success: true });
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, true);
            assert.equal(repo.performCheckinCalled, true);
        },
    },
    {
        name: '预检通过但 RPC 返回 cooldown（并发场景）→ 返回 cooldown',
        fn: async () => {
            const justExpired = new Date(Date.now() - CHECKIN_COOLDOWN_MS - 1000);
            const repo = new MockCheckinRepo(justExpired, { success: false, reason: 'cooldown' });
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, false);
            if (!result.success) {
                assert.equal(result.reason, 'cooldown');
            }
        },
    },
    {
        name: 'Repository 系统异常 → getLastCheckinTime 返回 undefined → 仍尝试 RPC',
        fn: async () => {
            const repo = new FailingCheckinRepo();
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, false);
            if (!result.success) {
                assert.equal(result.reason, 'system_error');
            }
        },
    },
    {
        name: 'RPC 系统异常 → 返回 system_error',
        fn: async () => {
            const repo = new MockCheckinRepo(null, { success: false, reason: 'system_error' });
            const uc = new CheckinUseCase(repo);
            const result = await uc.checkin('user1');

            assert.equal(result.success, false);
            if (!result.success) {
                assert.equal(result.reason, 'system_error');
            }
        },
    },
];

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    console.log('\n🧪 Checkin System Test Suite\n');

    await runSuite('Part A: Pure Functions (checkinRules.ts)', partA);
    await runSuite('Part B: UseCase (CheckinUseCase + Mock)', partB);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Results: ${results.passed} passed, ${results.failed} failed`);
    console.log('='.repeat(50));

    if (results.failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
