import fs from 'fs';
import path from 'path';
import config from '../../../platform/config.js';
import { STEngineAdapter } from '../../../infrastructure/st_matrix/STEngineAdapter.js';
import { createFetchInterceptor } from '../../../infrastructure/networking/FetchInterceptor.js';
import { logger } from '../../../platform/logger.js';
import type { SessionMessage, SessionStore } from '../../../core/ports/SessionStore.js';
import { UpstashSessionStore } from '../../../infrastructure/redis/UpstashSessionStore.js';

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
    lastActive: number;
}

/**
 * Session Manager (Layer 2 Service)
 * Responsibilities:
 * 1. Maintain active sessions in memory
 * 2. Handle session lifecycle (Creation, Retrieval, Destruction)
 * 3. Enforce LRU or Timeout policies
 */
export class SessionManager {
    private sessions: Map<string, ChatSession> = new Map();
    private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    private cleanupInterval: NodeJS.Timeout;
    private sessionStore: SessionStore | null = null;

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
        // Start cleanup job
        this.cleanupInterval = setInterval(() => this._cleanupStaleSessions(), 60 * 1000);
    }

    /**
     * Get an existing session or create a new one
     */
    async getOrCreateSession(userId: string): Promise<ChatSession> {
        // [Modified] 1. Always fetch latest state from Redis (Source of Truth)
        let redisSessionId: string | null = null;
        let redisHistory: OpenAIMessage[] = [];
        
        if (this.sessionStore) {
            try {
                redisSessionId = await this.sessionStore.getCurrentSessionId(userId);
                if (redisSessionId) {
                    redisHistory = await this.sessionStore.getMessages(redisSessionId);
                }
            } catch (error) {
                logger.warn({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'Failed to load session from store',
                    error,
                });
            }
        }

        // 2. Check memory cache for Engine/Config reuse
        let session = this.sessions.get(userId);

        if (session) {
            // Update session state from Redis
            if (redisSessionId) {
                session.sessionId = redisSessionId;
                session.history = redisHistory;
                session.lastActive = Date.now();
                return session;
            } else {
                // Redis session expired or missing -> Force recreate to restore default state (e.g. First Message)
                logger.info({ kind: 'biz', component: COMPONENT, message: 'Redis session missing, recreating', meta: { userId } });
                session = undefined;
            }
        }

        // 3. Create new session if needed (using Redis data if available, or fresh defaults)
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Creating new session' });
        session = await this._createSession(userId, redisSessionId, redisHistory);
        this.sessions.set(userId, session);
        return session;
    }

    /**
     * Internal: Create a new session with default character
     */
    private async _createSession(
        userId: string,
        existingSessionId?: string | null,
        existingHistory?: OpenAIMessage[]
    ): Promise<ChatSession> {
        // 1. Load Character (Mock Data Source)
        const charPath = path.join(config.st.mockDataPath, 'seraphina_v2.json');
        if (!fs.existsSync(charPath)) {
            const error = new Error(`Character file not found: ${charPath}`);
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Character file not found', error, meta: { charPath } });
            throw error;
        }
        const character = JSON.parse(fs.readFileSync(charPath, 'utf-8'));

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
            // [CRITICAL] Inject Default OpenAI Settings for Prompt Manager
            oai_settings: {
                preset_settings_openai: 'Default',
                openai_model: config.openai.model || 'gpt-3.5-turbo',
                system_prompt: 'You are {{char}}. Write a response that stays in character.',
                context_template: 'Default',
                chat_completion_source: 'openai',
                openai_max_context: 4096,
                openai_max_tokens: 300,
                openai_temperature: 0.7,
                prompts: [
                    // [DEBUG] Simplified Prompt to test injection
                    { 'name': 'Debug System', 'system_prompt': true, 'role': 'system', 'content': 'You are Seraphina. This is a debug prompt.', 'identifier': 'debug' }
                ],
                prompt_order: [
                    { 'identifier': 'debug', 'enabled': true }
                ]
            }
        }, networkHandler);

        await engine.initialize();

        // 3. Initialize History
        const history: OpenAIMessage[] = existingHistory && existingHistory.length > 0
            ? existingHistory
            : [];
        
        // Add System Prompt (Optional, ST usually handles this via character card)
        // history.push({ role: 'system', content: character.description });

        // Add First Message
        if (history.length === 0 && character.first_mes) {
            history.push({
                role: 'assistant',
                content: character.first_mes
            });
        }

        const sessionId = existingSessionId || `sess_${userId}_${Date.now()}`;
        logger.info({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'Session created', 
            meta: { sessionId, characterName: character.name } 
        });

        if (this.sessionStore) {
            try {
                await this.sessionStore.setCurrentSessionId(userId, sessionId);
                await this.sessionStore.setLastSessionId(userId, sessionId);
                await this.sessionStore.setSessionData(sessionId, {
                    session_id: sessionId,
                    user_id: userId,
                    character_name: character.name,
                });
                if (history.length > 0) {
                    await this.sessionStore.setMessages(sessionId, history);
                }
            } catch (error) {
                logger.warn({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'Failed to persist session metadata',
                    error,
                });
            }
        }

        return {
            sessionId,
            userId,
            engine,
            history,
            character,
            lastActive: Date.now()
        };
    }

    /**
     * Cleanup idle sessions to prevent memory leaks
     */
    private _cleanupStaleSessions(): void {
        const now = Date.now();
        for (const [userId, session] of this.sessions.entries()) {
            if (now - session.lastActive > this.SESSION_TIMEOUT_MS) {
                logger.info({ 
                    kind: 'biz', 
                    component: COMPONENT, 
                    message: 'Cleaning up stale session', 
                    meta: { userId, sessionId: session.sessionId, idleMinutes: Math.round((now - session.lastActive) / 60000) } 
                });
                // Optional: session.engine.destroy() if implemented
                this.sessions.delete(userId);
            }
        }
    }


    async appendMessages(session: ChatSession, messages: OpenAIMessage[]): Promise<void> {
        if (messages.length === 0) return;

        // [Modified] 1. Write to Redis ONLY (Source of Truth)
        // Memory update is removed because next read will enforce Redis state.
        if (this.sessionStore) {
            try {
                for (const message of messages) {
                    await this.sessionStore.appendMessage(session.sessionId, message);
                }
            } catch (error) {
                logger.warn({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'Failed to persist session history',
                    error,
                });
                // Critical: If Redis fails, we do NOT update memory. 
                // We accept that data is lost to avoid "ghost data" that disappears on next fetch.
                throw error; // Let the caller handle the failure UI
            }
        }
    }
}
