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
}

/**
 * Session Manager (Layer 2 Service)
 * Responsibilities:
 * 1. Handle session lifecycle (Creation, Retrieval)
 * 2. Interact with SessionStore (Redis) for persistence
 */
export class SessionManager {
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
    }

    /**
     * Get session data from Redis and reconstruct the session object
     */
    async getOrCreateSession(userId: string): Promise<ChatSession> {
        logger.debug({ kind: 'biz', component: COMPONENT, message: 'Resolving session from store' });
        let existingSessionId: string | null = null;
        let existingHistory: OpenAIMessage[] = [];
        
        if (this.sessionStore) {
            try {
                existingSessionId = await this.sessionStore.getCurrentSessionId(userId);
                if (existingSessionId) {
                    existingHistory = await this.sessionStore.getMessages(existingSessionId);
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

        const session = await this._createSession(userId, existingSessionId, existingHistory);
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
        if (!existingSessionId) {
             logger.info({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Session created', 
                meta: { sessionId, characterName: character.name } 
            });
        }

        if (this.sessionStore) {
            try {
                // Only set these if it's a new session or we want to ensure consistency
                await this.sessionStore.setCurrentSessionId(userId, sessionId);
                await this.sessionStore.setLastSessionId(userId, sessionId);
                await this.sessionStore.setSessionData(sessionId, {
                    session_id: sessionId,
                    user_id: userId,
                    character_name: character.name,
                });
                if (history.length > 0 && (!existingHistory || existingHistory.length === 0)) {
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
            character
        };
    }

    async appendMessages(session: ChatSession, messages: OpenAIMessage[]): Promise<void> {
        if (messages.length === 0) return;
        session.history.push(...messages);

        if (!this.sessionStore) {
            return;
        }

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
        }
    }

    async getUserModelMode(userId: string): Promise<string> {
        if (!this.sessionStore) return 'immersive';
        try {
            return await this.sessionStore.getUserModelMode(userId);
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to get user model mode', error });
            return 'immersive';
        }
    }

    async setUserModelMode(userId: string, mode: string): Promise<void> {
        if (!this.sessionStore) return;
        try {
            await this.sessionStore.setUserModelMode(userId, mode as 'fast' | 'story' | 'immersive');
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to set user model mode', error });
        }
    }
}
