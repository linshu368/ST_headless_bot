import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import config from '../../../platform/config.js';
import { UpstashSessionStore } from '../UpstashSessionStore.js';

const COMPONENT = 'UpstashSessionStoreTest';

type TestResult = {
    name: string;
    passed: boolean;
    error?: unknown;
};

function randomId(prefix: string): string {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function run(): Promise<void> {
    if (!config.redis.restUrl || !config.redis.token) {
        console.log(`[${COMPONENT}] Skipped: missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN`);
        process.exit(0);
    }

    const store = new UpstashSessionStore({
        restUrl: config.redis.restUrl,
        token: config.redis.token,
        namespace: `${config.redis.namespace}_test`,
        maxHistoryItems: 3,
        historyRetentionCount: 2,
        debug: false,
    });

    const results: TestResult[] = [];

    const sessionId = randomId('sess');
    const userId = randomId('user');

    const record = async (name: string, fn: () => Promise<void>) => {
        try {
            await fn();
            results.push({ name, passed: true });
        } catch (error) {
            results.push({ name, passed: false, error });
        }
    };

    await record('set/get messages', async () => {
        const initial = [
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'hi' },
        ];
        await store.setMessages(sessionId, initial);
        const readBack = await store.getMessages(sessionId);
        assert.equal(readBack.length, 2);
        assert.deepEqual(readBack[0], initial[0]);
        assert.deepEqual(readBack[1], initial[1]);
    });

    await record('append + trim history', async () => {
        const ids = [
            { role: 'user', content: 'm1' },
            { role: 'assistant', content: 'm2' },
            { role: 'user', content: 'm3' },
            { role: 'assistant', content: 'm4' },
        ];
        for (const message of ids) {
            await store.appendMessage(sessionId, message);
        }
        const readBack = await store.getMessages(sessionId);
        assert.equal(readBack.length, 2);
        assert.deepEqual(readBack[0], ids[2]);
        assert.deepEqual(readBack[1], ids[3]);
    });

    await record('session pointer & metadata', async () => {
        await store.setCurrentSessionId(userId, sessionId);
        await store.setLastSessionId(userId, sessionId);
        const current = await store.getCurrentSessionId(userId);
        const last = await store.getLastSessionId(userId);
        assert.equal(current, sessionId);
        assert.equal(last, sessionId);

        const data = { session_id: sessionId, user_id: userId, tag: 'test' };
        await store.setSessionData(sessionId, data);
        const readData = await store.getSessionData(sessionId);
        assert.equal(readData?.session_id, sessionId);
        assert.equal(readData?.user_id, userId);
        assert.equal(readData?.tag, 'test');
    });

    await record('user model mode', async () => {
        await store.setUserModelMode(userId, 'fast');
        const mode = await store.getUserModelMode(userId);
        assert.equal(mode, 'fast');
    });

    const failed = results.filter((r) => !r.passed);
    for (const result of results) {
        const label = result.passed ? 'PASS' : 'FAIL';
        console.log(`[${COMPONENT}] ${label} - ${result.name}`);
        if (result.error) {
            console.error(result.error);
        }
    }

    if (failed.length > 0) {
        process.exit(1);
    }
}

run().catch((error) => {
    console.error(`[${COMPONENT}] Unexpected error`, error);
    process.exit(1);
});
