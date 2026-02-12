import type { SessionStore } from '../../../core/ports/SessionStore.js';

export type ResolveSessionResult = {
    sessionId: string;
    isNew: boolean;
    expiredSessionId?: string;
};

/**
 * Pure session ID resolution with "experience window" semantics.
 * Used by SessionManager; exported for unit testing expiration policy.
 *
 * @param sessionStore - Store for current/last session id and lastActive
 * @param userId - User identifier
 * @param timeoutMinutes - Inactivity timeout in minutes
 * @param now - Current time in ms (default: Date.now(); inject for tests)
 */
export async function resolveSessionId(
    sessionStore: SessionStore,
    userId: string,
    timeoutMinutes: number,
    now: number = Date.now()
): Promise<ResolveSessionResult> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const existingSessionId = await sessionStore.getCurrentSessionId(userId);

    if (existingSessionId) {
        const lastActive = await sessionStore.getLastActiveTime(userId);

        if (lastActive && now - lastActive > timeoutMs) {
            const newSessionId = `sess_${userId}_${now}`;
            // Business semantics:
            // - currentSessionId: active experience window
            // - lastSessionId: previous (just-expired) experience window
            await sessionStore.setLastSessionId(userId, existingSessionId);
            await sessionStore.setCurrentSessionId(userId, newSessionId);
            await sessionStore.setLastActiveTime(userId, now);
            return { sessionId: newSessionId, isNew: true, expiredSessionId: existingSessionId };
        }

        await sessionStore.setLastActiveTime(userId, now);
        return { sessionId: existingSessionId, isNew: false };
    }

    const newSessionId = `sess_${userId}_${now}`;
    await sessionStore.setCurrentSessionId(userId, newSessionId);
    await sessionStore.setLastActiveTime(userId, now);
    return { sessionId: newSessionId, isNew: true };
}
