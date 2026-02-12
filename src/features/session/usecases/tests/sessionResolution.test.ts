/**
 * Unit tests for session_id expiration policy (体验窗口).
 *
 * Policy under test:
 * - session_id = one "experience window"
 * - Within timeout → reuse session_id and touch lastActive
 * - Beyond timeout → new session_id, expiredSessionId returned
 * - No lastActive (migration) → treat as active, reuse and touch
 */

import assert from 'node:assert/strict';
import type { SessionMessage, SessionStore } from '../../../../core/ports/SessionStore.js';
import { resolveSessionId } from '../sessionResolution.js';

const TEST_USER = 'user_test_1';
const TIMEOUT_MINUTES = 30;

/** In-memory SessionStore for testing */
class MockSessionStore implements SessionStore {
    private currentByUser = new Map<string, string>();
    private lastByUser = new Map<string, string>();
    private lastActiveByUser = new Map<string, number>();
    private messagesBySession = new Map<string, SessionMessage[]>();
    private sessionDataBySession = new Map<string, Record<string, unknown>>();
    private modelModeByUser = new Map<string, 'basic' | 'standard_a' | 'standard_b'>();

    async getMessages(sessionId: string): Promise<SessionMessage[]> {
        return this.messagesBySession.get(sessionId) ?? [];
    }
    async setMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
        this.messagesBySession.set(sessionId, [...messages]);
    }
    async appendMessage(sessionId: string, message: SessionMessage): Promise<void> {
        const list = this.messagesBySession.get(sessionId) ?? [];
        list.push(message);
        this.messagesBySession.set(sessionId, list);
    }
    async getCurrentSessionId(userId: string): Promise<string | null> {
        return this.currentByUser.get(userId) ?? null;
    }
    async setCurrentSessionId(userId: string, sessionId: string): Promise<void> {
        this.currentByUser.set(userId, sessionId);
    }
    async getLastSessionId(userId: string): Promise<string | null> {
        return this.lastByUser.get(userId) ?? null;
    }
    async setLastSessionId(userId: string, sessionId: string): Promise<void> {
        this.lastByUser.set(userId, sessionId);
    }
    async getSessionData(sessionId: string): Promise<Record<string, unknown> | null> {
        return this.sessionDataBySession.get(sessionId) ?? null;
    }
    async setSessionData(sessionId: string, data: Record<string, unknown>): Promise<void> {
        this.sessionDataBySession.set(sessionId, { ...data });
    }
    async getUserModelMode(userId: string): Promise<'basic' | 'standard_a' | 'standard_b'> {
        return this.modelModeByUser.get(userId) ?? 'standard_b';
    }
    async setUserModelMode(userId: string, mode: 'basic' | 'standard_a' | 'standard_b'): Promise<void> {
        this.modelModeByUser.set(userId, mode);
    }
    async getLastActiveTime(userId: string): Promise<number | null> {
        return this.lastActiveByUser.get(userId) ?? null;
    }
    async setLastActiveTime(userId: string, timestamp: number): Promise<void> {
        this.lastActiveByUser.set(userId, timestamp);
    }
}

type TestCase = { name: string; fn: () => Promise<void> };

async function run(): Promise<void> {
    const store = new MockSessionStore();
    const baseTime = 1_000_000_000_000; // fixed "now" for reproducibility
    const timeoutMs = TIMEOUT_MINUTES * 60 * 1000;

    const tests: TestCase[] = [
        {
            name: '首次访问：无当前会话 → 创建新 session_id，isNew=true',
            fn: async () => {
                const r = await resolveSessionId(store, TEST_USER, TIMEOUT_MINUTES, baseTime);
                assert.match(r.sessionId, /^sess_user_test_1_\d+$/);
                assert.equal(r.isNew, true);
                assert.equal(r.expiredSessionId, undefined);
                const current = await store.getCurrentSessionId(TEST_USER);
                assert.equal(current, r.sessionId);
                const last = await store.getLastSessionId(TEST_USER);
                assert.equal(last, null);
                const lastActive = await store.getLastActiveTime(TEST_USER);
                assert.equal(lastActive, baseTime);
            },
        },
        {
            name: '在超时时间内再次请求 → 复用同一 session_id，isNew=false，并 touch lastActive',
            fn: async () => {
                const first = await resolveSessionId(store, TEST_USER, TIMEOUT_MINUTES, baseTime);
                const later = baseTime + 10 * 60 * 1000; // +10 min
                const r = await resolveSessionId(store, TEST_USER, TIMEOUT_MINUTES, later);
                assert.equal(r.sessionId, first.sessionId);
                assert.equal(r.isNew, false);
                assert.equal(r.expiredSessionId, undefined);
                const lastActive = await store.getLastActiveTime(TEST_USER);
                assert.equal(lastActive, later);
            },
        },
        {
            name: '超过超时时间未活动 → 创建新 session_id，isNew=true，返回 expiredSessionId',
            fn: async () => {
                const oldSessionId = (await store.getCurrentSessionId(TEST_USER))!;
                // 上一次 touch 在 baseTime+10min，需在 30min 之后才过期
                const lastTouch = baseTime + 10 * 60 * 1000;
                const afterTimeout = lastTouch + timeoutMs + 1;
                const r = await resolveSessionId(store, TEST_USER, TIMEOUT_MINUTES, afterTimeout);
                assert.notEqual(r.sessionId, oldSessionId);
                assert.match(r.sessionId, /^sess_user_test_1_\d+$/);
                assert.equal(r.isNew, true);
                assert.equal(r.expiredSessionId, oldSessionId);
                const current = await store.getCurrentSessionId(TEST_USER);
                assert.equal(current, r.sessionId);
                const last = await store.getLastSessionId(TEST_USER);
                assert.equal(last, oldSessionId);
                const lastActive = await store.getLastActiveTime(TEST_USER);
                assert.equal(lastActive, afterTimeout);
            },
        },
        {
            name: '迁移场景：有 currentSessionId 但无 lastActive → 视为未过期，复用并 touch',
            fn: async () => {
                const userId2 = 'user_migration';
                const existingSid = 'sess_user_migration_999';
                await store.setCurrentSessionId(userId2, existingSid);
                // 不设置 lastActive
                const r = await resolveSessionId(store, userId2, TIMEOUT_MINUTES, baseTime + 100);
                assert.equal(r.sessionId, existingSid);
                assert.equal(r.isNew, false);
                assert.equal(r.expiredSessionId, undefined);
                const lastActive = await store.getLastActiveTime(userId2);
                assert.equal(lastActive, baseTime + 100);
            },
        },
        {
            name: '恰好处于超时边界（lastActive + timeout）→ 未过期，复用',
            fn: async () => {
                const userId3 = 'user_boundary';
                const sid = 'sess_user_boundary_1';
                await store.setCurrentSessionId(userId3, sid);
                const lastActive = baseTime;
                await store.setLastActiveTime(userId3, lastActive);
                const exactlyAtTimeout = lastActive + timeoutMs; // 刚好等于 timeout，不应过期（> 才过期）
                const r = await resolveSessionId(store, userId3, TIMEOUT_MINUTES, exactlyAtTimeout);
                assert.equal(r.sessionId, sid);
                assert.equal(r.isNew, false);
            },
        },
        {
            name: '超过边界 1ms → 过期，新建 session',
            fn: async () => {
                const userId4 = 'user_boundary2';
                const sid = 'sess_user_boundary2_1';
                await store.setCurrentSessionId(userId4, sid);
                await store.setLastActiveTime(userId4, baseTime);
                const justOver = baseTime + timeoutMs + 1;
                const r = await resolveSessionId(store, userId4, TIMEOUT_MINUTES, justOver);
                assert.notEqual(r.sessionId, sid);
                assert.equal(r.isNew, true);
                assert.equal(r.expiredSessionId, sid);
                const last = await store.getLastSessionId(userId4);
                assert.equal(last, sid);
            },
        },
    ];

    let passed = 0;
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  PASS: ${t.name}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL: ${t.name}`);
            console.error(err);
            failed++;
        }
    }

    console.log(`\nSession resolution: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error('Unexpected error', err);
    process.exit(1);
});
