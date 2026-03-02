import fs from 'fs';
import path from 'path';
import config from '../../../platform/config.js';
import { STEngineAdapter } from '../../../infrastructure/st_matrix/STEngineAdapter.js';
import { createFetchInterceptor } from '../../../infrastructure/networking/FetchInterceptor.js';
import { logger } from '../../../platform/logger.js';
import type { RequestTimer } from '../../../platform/RequestTimer.js';
import type { SessionMessage, SessionStore } from '../../../core/ports/SessionStore.js';
import { resolveSessionId as resolveSessionIdPure } from './sessionResolution.js';
import { UpstashSessionStore } from '../../../infrastructure/redis/UpstashSessionStore.js';
import { SupabaseSnapshotRepository, type ChatSnapshot } from '../../../infrastructure/repositories/SupabaseSnapshotRepository.js';
import { mapDbRowToCharacterV2, type RoleDataRow } from '../../../infrastructure/supabase/CharacterMapper.js';
import { supabase } from '../../../infrastructure/supabase/SupabaseClient.js';
import { runtimeConfig } from '../../../infrastructure/runtime_config/RuntimeConfigService.js';

const COMPONENT = 'SessionManager';

/**
 * Standard OpenAI Message Format (Layer 2 Pure)
 */
export type OpenAIMessage = SessionMessage;

/**
 * Chat Session Entity
 */
export interface ChatSession {
    sessionId: string;
    userId: string;
    engine: STEngineAdapter;
    history: OpenAIMessage[];
    character: any; // ST V2 Spec
    turnCount: number;
    round: number; // context-continuous depth: accumulates within same context, resets on new chat / switch character
}

/**
 * Session Manager (Layer 2 Service)
 * Responsibilities:
 * 1. Handle session lifecycle (Creation, Retrieval)
 * 2. Interact with SessionStore (Redis) for persistence
 */
export class SessionManager {
    private sessionStore: SessionStore | null = null;
    private snapshotRepository: SupabaseSnapshotRepository;

    constructor() {
        if (config.redis.restUrl && config.redis.token) {
            this.sessionStore = new UpstashSessionStore({
                restUrl: config.redis.restUrl,
                token: config.redis.token,
                namespace: config.redis.namespace,
                maxHistoryItems: config.redis.maxHistoryItems,
                historyRetentionCount: config.redis.historyRetentionCount,
            });
        } else {
            logger.info({ kind: 'biz', component: COMPONENT, message: 'Redis store disabled' });
        }
        this.snapshotRepository = new SupabaseSnapshotRepository();
    }

    /**
     * Helper: 从 RuntimeConfigService 刷新 UpstashSessionStore 的动态限制
     * 内存缓存命中时开销为 0ms，每 60s 回源一次
     */
    private async refreshStoreLimits(): Promise<void> {
        if (this.sessionStore && this.sessionStore instanceof UpstashSessionStore) {
            try {
                const maxItems = await runtimeConfig.getMaxHistoryItems();
                const retentionCount = await runtimeConfig.getHistoryRetentionCount();
                this.sessionStore.setMaxHistoryItems(maxItems);
                this.sessionStore.setHistoryRetentionCount(retentionCount);
            } catch {
                // Non-critical: use existing value
            }
        }
    }

    /**
     * Helper: Update session metadata with merge semantics.
     * Keeps callsites small and consistent, and centralizes error handling.
     */
    private async _updateSessionData(
        sessionId: string,
        updates: Record<string, unknown>
    ): Promise<void> {
        if (!this.sessionStore) return;
        try {
            const currentData = (await this.sessionStore.getSessionData(sessionId)) || {};
            await this.sessionStore.setSessionData(sessionId, {
                ...currentData,
                ...updates,
            });
        } catch (error) {
            logger.warn({
                kind: 'biz',
                component: COMPONENT,
                message: 'Failed to update session metadata',
                error,
                meta: { sessionId, keys: Object.keys(updates) },
            });
        }
    }

    /**
     * Helper: Load character data (Supabase > Mock)
     */
    private async _loadCharacter(roleId?: string): Promise<any> {
        let character: any = null;

        // 1. Try Supabase if roleId provided
        if (roleId && supabase) {
            try {
                const { data, error } = await supabase
                    .from('role_data')
                    .select('*')
                    .eq('role_id', roleId)
                    .single();
                
                if (data) {
                    const row = data as RoleDataRow;
                    character = mapDbRowToCharacterV2(row).data;
                    logger.debug({ kind: 'biz', component: COMPONENT, message: 'Character loaded from Supabase', meta: { roleId, name: character.name } });
                } else if (error) {
                    logger.warn({ kind: 'biz', component: COMPONENT, message: 'Supabase character lookup failed', error });
                }
            } catch (err) {
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Supabase error', error: err });
            }
        } else if (roleId && !supabase) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Supabase client unavailable; skipping character lookup', meta: { roleId } });
        }

        // 2. Fallback to Mock Data
        if (!character) {
            // User specified fallback path
            const charPath = path.resolve(process.cwd(), 'scripts/publisher/step1/character_v2.json');
            
            if (fs.existsSync(charPath)) {
                try {
                    const fileContent = fs.readFileSync(charPath, 'utf-8');
                    let mockChar = JSON.parse(fileContent);

                    // Handle Array format (common in some exports)
                    if (Array.isArray(mockChar) && mockChar.length > 0) {
                        mockChar = mockChar[0];
                    }

                    if (mockChar.spec === 'chara_card_v2' && mockChar.data) {
                        mockChar = mockChar.data;
                    }
                    character = mockChar;
                    
                    // Only log if we were expecting a specific role but failed
                    if (roleId) {
                        logger.info({ kind: 'biz', component: COMPONENT, message: 'Fallback to local mock character', meta: { charPath } });
                    }
                } catch (error) {
                    logger.error({ kind: 'biz', component: COMPONENT, message: 'Failed to parse mock character file', error });
                }
            } else {
                 logger.warn({ kind: 'biz', component: COMPONENT, message: 'Mock character file not found', meta: { charPath } });
            }
        }

        if (!character) {
            throw new Error('No character data available (neither Supabase nor Mock)');
        }

        return character;
    }

    /**
     * Core: Resolve session ID with "experience window" semantics.
     * 
     * Business Rule:
     * - session_id represents "one complete user experience" (体验窗口)
     * - If user has been active within the timeout window → reuse existing session_id
     * - If user has been inactive beyond the timeout → create new session_id
     * - Actions like new_chat, switch_character, restore_snapshot do NOT create new session_id
     *   as long as the user is within the same experience window.
     * 
     * Migration: If no lastActive record exists (pre-deployment sessions),
     *            the session is treated as still active to avoid disruption.
     */
    private async _resolveSessionId(userId: string): Promise<{ sessionId: string; isNew: boolean; expiredSessionId?: string }> {
        if (!this.sessionStore) {
            return { sessionId: `sess_${userId}_${Date.now()}`, isNew: true };
        }
        const timeoutMinutes = await runtimeConfig.getSessionTimeoutMinutes();
        const result = await resolveSessionIdPure(
            this.sessionStore,
            userId,
            timeoutMinutes
        );
        if (result.isNew && result.expiredSessionId) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'Session expired, new experience window',
                meta: { userId, oldSessionId: result.expiredSessionId, newSessionId: result.sessionId }
            });
        } else if (result.isNew) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'First session created',
                meta: { userId, sessionId: result.sessionId }
            });
        }
        return result;
    }

    /**
     * Get session data from Redis and reconstruct the session object
     */
    async getOrCreateSession(userId: string, timer?: RequestTimer): Promise<ChatSession> {
        logger.debug({ kind: 'biz', component: COMPONENT, message: 'Resolving session from store' });

        // 1. Resolve session ID (handles expiry + touch)
        const { sessionId, isNew, expiredSessionId } = await this._resolveSessionId(userId);
        timer?.mark('sid_resolved');

        // 2. Parallel fetch: session data + default role ID
        // (was 4 sequential Redis/Supabase calls → 1 parallel round)
        let historyPromise: Promise<OpenAIMessage[]>;
        let sessionDataPromise: Promise<Record<string, unknown> | null>;

        if (!isNew && this.sessionStore) {
            historyPromise = this.sessionStore.getMessages(sessionId).catch(error => {
                logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to load messages', error });
                return [] as OpenAIMessage[];
            });
            sessionDataPromise = this.sessionStore.getSessionData(sessionId).catch(error => {
                logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to load session data', error });
                return null;
            });
        } else if (isNew && expiredSessionId && this.sessionStore) {
            // Inherit full history from expired session — session_id is an internal metric,
            // user experience should feel like "picking up where I left off"
            historyPromise = this.sessionStore.getMessages(expiredSessionId).catch(error => {
                logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to inherit history from expired session', error });
                return [] as OpenAIMessage[];
            });
            sessionDataPromise = this.sessionStore.getSessionData(expiredSessionId).then(prevData => {
                if (prevData) {
                    logger.info({ kind: 'biz', component: COMPONENT, message: 'Session context carried over from expired session', meta: { expiredSessionId, roleId: prevData.role_id, round: prevData.round } });
                    // turn_count resets (session-scoped), round carries over (context-continuous)
                    return { ...prevData, turn_count: 0 } as Record<string, unknown>;
                }
                return { turn_count: 0, round: 0 } as Record<string, unknown>;
            }).catch(error => {
                logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to carry over session data', error });
                return { turn_count: 0, round: 0 } as Record<string, unknown>;
            });
        } else {
            historyPromise = Promise.resolve([]);
            sessionDataPromise = Promise.resolve(null);
        }

        const [existingHistory, existingSessionData, defaultRoleId] = await Promise.all([
            historyPromise,
            sessionDataPromise,
            runtimeConfig.getDefaultRoleId(),
        ]);
        timer?.mark('history_loaded');

        // 3. Determine Role ID from Session Data
        const currentRoleId = (existingSessionData?.role_id as string | undefined) || defaultRoleId;
        const character = await this._loadCharacter(currentRoleId);
        timer?.mark('char_loaded');

        // 4. Build session object
        const session = await this._createSession(userId, character, sessionId, existingHistory, existingSessionData);
        timer?.mark('session_built');

        // Persist inherited history to new session's Redis key so it survives restarts
        if (isNew && expiredSessionId && this.sessionStore && existingHistory.length > 0) {
            this.sessionStore.setMessages(sessionId, existingHistory).catch(error => {
                logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to persist inherited history to new session', error, meta: { sessionId } });
            });
        }

        return session;
    }

    /**
     * Internal: Create a new session with provided character
     */
    private async _createSession(
        userId: string,
        character: any,
        sessionId: string,
        existingHistory?: OpenAIMessage[],
        existingSessionData?: Record<string, unknown> | null
    ): Promise<ChatSession> {
        // 1. Character is now passed in (No file loading here)

        // 2. Initialize Adapter Chain (Layer 4)
        const networkHandler = createFetchInterceptor({
            api_key_openai: config.openai.apiKey,
            api_url_openai: config.openai.apiUrl,
            openai_model: config.openai.model
        });
        networkHandler.setMockData({
            characters: [character],
            chats: []
        });

        const engine = new STEngineAdapter({
            main_api: 'openai',
            api_key_openai: config.openai.apiKey,
            api_url_openai: config.openai.apiUrl,
            openai_model: config.openai.model,
            // [CRITICAL] Inject Dynamic OpenAI Settings
            // This configuration drives the ST Core Prompt Manager to build the prompt exactly as requested:
            // Part 1: character.system_prompt (via 'main')
            // Part 2 & 3 & 4: First Message + History + User Input (via 'chatHistory' marker)
            oai_settings: {
                preset_settings_openai: 'Default',
                openai_model: config.openai.model || 'gpt-3.5-turbo',
                system_prompt: character.system_prompt || '', // Fallback for UI display
                context_template: 'Default',
                chat_completion_source: 'openai',
                openai_max_context: 4096,
                openai_max_tokens: 10000, 
                openai_temperature: 0.7,
                prompts: [
                    { 
                        identifier: 'main', 
                        name: 'Main Prompt', 
                        system_prompt: true, 
                        role: 'system', 
                        content: character.system_prompt || '', 
                        enabled: true 
                    },
                    { 
                        identifier: 'chatHistory', 
                        name: 'Chat History', 
                        system_prompt: false, 
                        marker: true,
                        enabled: true
                    }
                ],
                prompt_order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'chatHistory', enabled: true }
                ]
            }
        }, networkHandler);

        await engine.initialize();

        // 3. Initialize History
        const history: OpenAIMessage[] = existingHistory && existingHistory.length > 0
            ? existingHistory
            : [];
        
        // Initialize Turn Count
        let turnCount = 0;
        if (existingSessionData && typeof existingSessionData.turn_count === 'number') {
            turnCount = existingSessionData.turn_count;
        } else if (history.length > 0) {
            // Fallback for migration: approximate turn count
            turnCount = Math.floor(history.length / 2);
        }

        // Initialize Round (context-continuous depth)
        let round = 0;
        if (existingSessionData && typeof existingSessionData.round === 'number') {
            round = existingSessionData.round;
        } else if (history.length > 0) {
            round = Math.floor(history.length / 2);
        }

        // NOTE: We do NOT inject first_mes into history here anymore.
        // It should be constructed dynamically during prompt assembly to keep Redis clean.

        // Persist session metadata (fire-and-forget: not on critical path)
        // IMPORTANT: round is excluded — it is only mutated by appendMessages (+1),
        // resetSessionHistory (=0), switchCharacter (=0), restoreSnapshot (=snapshot.round).
        // This fire-and-forget uses _updateSessionData (merge) so it never clobbers
        // a round value written by those authoritative call-sites.
        this._updateSessionData(sessionId, {
            session_id: sessionId,
            user_id: userId,
            role_id: character.extensions?.role_id,
            turn_count: turnCount,
        }).catch(error => {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to persist session metadata (non-fatal)', error, meta: { sessionId } });
        });

        return {
            sessionId,
            userId,
            engine,
            history,
            character,
            turnCount,
            round
        };
    }

    /**
     * Switch character for the current user
     * @param userId User ID
     * @param roleId Target Role ID
     * @returns New Character Data
     */
    async switchCharacter(userId: string, roleId: string): Promise<any> {
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Switching character', meta: { userId, roleId } });

        // 1. Load New Character
        const character = await this._loadCharacter(roleId);

        // 2. Resolve Session ID (respects experience window, auto-touch)
        const { sessionId } = await this._resolveSessionId(userId);

        // 3. Clear History & Update Metadata (context broken → round resets)
        if (this.sessionStore) {
            try {
                await this.sessionStore.setMessages(sessionId, []);
                await this._updateSessionData(sessionId, {
                    role_id: character.extensions?.role_id,
                    post_link: character.extensions?.post_link,
                    avatar: character.extensions?.avatar,
                    round: 0,
                });
                logger.info({ kind: 'biz', component: COMPONENT, message: 'Session updated for new character', meta: { sessionId, roleId: character.extensions?.role_id } });
            } catch (error) {
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Failed to update session for character switch', error });
                throw error;
            }
        }

        return character;
    }

    async appendMessages(session: ChatSession, messages: OpenAIMessage[]): Promise<void> {
        if (messages.length === 0) return;
        session.history.push(...messages);

        // Update Turn Count & Round
        const hasUser = messages.some(m => m.role === 'user');
        const hasAssistant = messages.some(m => m.role === 'assistant');
        let countersUpdated = false;

        if (hasUser && hasAssistant) {
            session.turnCount += 1;
            session.round += 1;
            countersUpdated = true;
        }

        if (!this.sessionStore) {
            return;
        }

        // 刷新动态历史上限（从 RuntimeConfig 获取，内存缓存命中时 0ms）
        await this.refreshStoreLimits();

        try {
            for (const message of messages) {
                await this.sessionStore.appendMessage(session.sessionId, message);
            }

            if (countersUpdated) {
                await this._updateSessionData(session.sessionId, {
                    turn_count: session.turnCount,
                    round: session.round,
                });
            }
        } catch (error) {
            logger.warn({
                kind: 'biz',
                component: COMPONENT,
                message: 'Failed to persist session history',
                error,
            });
        }
    }

    /**
     * Rollback session history to the last user message.
     * This ensures the next generation starts fresh from the last user input,
     * removing any previous (potentially bad) bot responses.
     * 
     * @param session The chat session to rollback
     * @returns The content of the last user message to be regenerated
     */
    async rollbackHistoryToLastUser(session: ChatSession): Promise<string | null> {
        // 1. Find the index of the last user message in the current in-memory history
        let lastUserIndex = -1;
        for (let i = session.history.length - 1; i >= 0; i--) {
            if (session.history[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }

        if (lastUserIndex === -1) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'No user message found to rollback to' });
            return null;
        }

        const lastUserMessage = session.history[lastUserIndex];
        const lastUserContent = typeof lastUserMessage.content === 'string' 
            ? lastUserMessage.content 
            : String(lastUserMessage.content);

        // 2. Truncate in-memory history
        // We keep everything up to and including the user message.
        // The bot's new response will be appended after this.
        session.history = session.history.slice(0, lastUserIndex + 1);

        logger.info({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'History rolled back', 
            meta: { 
                sessionId: session.sessionId, 
                lastUserIndex, 
                keptCount: session.history.length 
            } 
        });

        // 3. Sync with Redis
        if (this.sessionStore) {
            try {
                // We overwrite the full list to ensure consistency.
                // This avoids race conditions with RPOP/LTRIM and handles complex history states.
                // Since this is a manual user action, the cost of SET is acceptable.
                await this.sessionStore.setMessages(session.sessionId, session.history);
            } catch (error) {
                logger.error({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'Failed to persist rolled back history',
                    error,
                });
                // We proceed even if persistence fails, though it might lead to inconsistency on next reload
            }
        }

        return lastUserContent;
    }

    /**
     * Clear session history for a fresh start, preserving metadata (role) but resetting counters.
     * Context is broken → round resets to 0.
     */
    async resetSessionHistory(userId: string): Promise<void> {
        if (!this.sessionStore) return;

        // Resolve session ID (also touches lastActive)
        const { sessionId } = await this._resolveSessionId(userId);

        logger.info({ kind: 'biz', component: COMPONENT, message: 'Resetting session history', meta: { userId, sessionId } });

        await this.sessionStore.setMessages(sessionId, []);
        await this._updateSessionData(sessionId, { round: 0 });
    }

    async getUserModelMode(userId: string): Promise<string> {
        if (!this.sessionStore) return 'tier_3';
        try {
            return await this.sessionStore.getUserModelMode(userId);
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to get user model mode', error });
            return 'tier_3';
        }
    }

    async setUserModelMode(userId: string, mode: string): Promise<void> {
        if (!this.sessionStore) return;
        try {
            await this.sessionStore.setUserModelMode(userId, mode as 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4');
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to set user model mode', error });
        }
    }

    /**
     * Public wrapper: Load character data by roleId
     */
    async loadCharacterByRoleId(roleId: string): Promise<any> {
        return this._loadCharacter(roleId);
    }

    /**
     * Create a snapshot of the current session
     * snapshot_name format: "{YYYYMMDD_HHMMSS}_{userLabel}_{角色名}"
     * @param userLabel 用户自定义名称，直接保存时传 "未命名"
     */
    async createSnapshot(userId: string, userLabel: string): Promise<string | null> {
        const session = await this.getOrCreateSession(userId);
        if (!session.history || session.history.length === 0) {
            return null;
        }

        const defaultRoleId = await runtimeConfig.getDefaultRoleId();
        const roleId = session.character?.extensions?.role_id || defaultRoleId;
        const characterTitle = session.character?.extensions?.title || session.character?.name || '未知角色';
        
        // 生成时间戳: YYYYMMDD_HHMMSS
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const fullName = `${ts}_${userLabel}_${characterTitle}`;
        
        return await this.snapshotRepository.createSnapshot(
            userId, 
            roleId, 
            fullName, 
            session.history,
            session.round
        );
    }

    /**
     * Get all snapshots for a user
     */
    async getSnapshots(userId: string): Promise<ChatSnapshot[]> {
        return await this.snapshotRepository.getSnapshots(userId);
    }

    /**
     * Get a specific snapshot
     */
    async getSnapshot(snapshotId: string): Promise<ChatSnapshot | null> {
        return await this.snapshotRepository.getSnapshot(snapshotId);
    }

    /**
     * Restore a snapshot into the current session (reuse experience window).
     * No longer creates a new session_id — the snapshot's history replaces the current one.
     */
    async restoreSnapshot(userId: string, snapshotId: string): Promise<boolean> {
        // 1. Fetch snapshot
        const snapshot = await this.snapshotRepository.getSnapshot(snapshotId);
        if (!snapshot) return false;

        // 2. Load associated character
        const character = await this._loadCharacter(snapshot.role_id);
        if (!character) return false;

        // 3. Resolve Session ID (reuse current experience window, auto-touch)
        const { sessionId } = await this._resolveSessionId(userId);

        // 4. Replace history + update metadata in current session
        if (this.sessionStore) {
            try {
                // Replace history with snapshot's history
                await this.sessionStore.setMessages(sessionId, snapshot.history || []);

                // Restore session metadata including round (context-continuous from snapshot)
                const restoredRound = snapshot.round ?? Math.floor((snapshot.history?.length || 0) / 2);
                await this._updateSessionData(sessionId, {
                    role_id: snapshot.role_id,
                    post_link: character.extensions?.post_link,
                    avatar: character.extensions?.avatar,
                    round: restoredRound,
                });

                logger.info({ 
                    kind: 'biz', 
                    component: COMPONENT, 
                    message: 'Snapshot restored into current session', 
                    meta: { userId, snapshotId, sessionId, round: restoredRound } 
                });
                return true;

            } catch (error) {
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Failed to restore snapshot', error });
                return false;
            }
        }

        return false;
    }

    /**
     * Delete a snapshot
     */
    async deleteSnapshot(snapshotId: string): Promise<boolean> {
        return await this.snapshotRepository.deleteSnapshot(snapshotId);
    }
}
