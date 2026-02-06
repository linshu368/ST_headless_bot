import fs from 'fs';
import path from 'path';
import config from '../../../platform/config.js';
import { STEngineAdapter } from '../../../infrastructure/st_matrix/STEngineAdapter.js';
import { createFetchInterceptor } from '../../../infrastructure/networking/FetchInterceptor.js';
import { logger } from '../../../platform/logger.js';
import type { SessionMessage, SessionStore } from '../../../core/ports/SessionStore.js';
import { UpstashSessionStore } from '../../../infrastructure/redis/UpstashSessionStore.js';
import { supabase } from '../../../infrastructure/supabase/SupabaseClient.js';
import { mapDbRowToCharacterV2, type RoleDataRow } from '../../../infrastructure/supabase/CharacterMapper.js';

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
        let existingSessionData: Record<string, unknown> | null = null;
        
        if (this.sessionStore) {
            try {
                existingSessionId = await this.sessionStore.getCurrentSessionId(userId);
                if (existingSessionId) {
                    existingHistory = await this.sessionStore.getMessages(existingSessionId);
                    existingSessionData = await this.sessionStore.getSessionData(existingSessionId);
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

        const session = await this._createSession(userId, existingSessionId, existingHistory, existingSessionData);
        return session;
    }

    /**
     * Internal: Create a new session with default character
     */
    private async _createSession(
        userId: string,
        existingSessionId?: string | null,
        existingHistory?: OpenAIMessage[],
        existingSessionData?: Record<string, unknown> | null
    ): Promise<ChatSession> {
        // 1. Load Character (Mock Data Source)
        const charPath = path.join(config.st.mockDataPath, 'seraphina_v2.json');
        if (!fs.existsSync(charPath)) {
            const error = new Error(`Character file not found: ${charPath}`);
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Character file not found', error, meta: { charPath } });
            throw error;
        }
        let character = JSON.parse(fs.readFileSync(charPath, 'utf-8'));
        
        // Handle V2 Character Card
        if (character.spec === 'chara_card_v2' && character.data) {
            character = character.data;
        }

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
                openai_max_tokens: 300,
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

        // NOTE: We do NOT inject first_mes into history here anymore.
        // It should be constructed dynamically during prompt assembly to keep Redis clean.

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
                    turn_count: turnCount,
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
            character,
            turnCount
        };
    }

    async appendMessages(session: ChatSession, messages: OpenAIMessage[]): Promise<void> {
        if (messages.length === 0) return;
        session.history.push(...messages);

        // Update Turn Count
        const hasUser = messages.some(m => m.role === 'user');
        const hasAssistant = messages.some(m => m.role === 'assistant');
        let turnCountUpdated = false;

        if (hasUser && hasAssistant) {
            session.turnCount += 1;
            turnCountUpdated = true;
        }

        if (!this.sessionStore) {
            return;
        }

        try {
            for (const message of messages) {
                await this.sessionStore.appendMessage(session.sessionId, message);
            }

            if (turnCountUpdated) {
                const currentData = await this.sessionStore.getSessionData(session.sessionId) || {};
                await this.sessionStore.setSessionData(session.sessionId, {
                    ...currentData,
                    turn_count: session.turnCount
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

    async getUserModelMode(userId: string): Promise<string> {
        if (!this.sessionStore) return 'standard_b';
        try {
            return await this.sessionStore.getUserModelMode(userId);
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to get user model mode', error });
            return 'standard_b';
        }
    }

    async setUserModelMode(userId: string, mode: string): Promise<void> {
        if (!this.sessionStore) return;
        try {
            await this.sessionStore.setUserModelMode(userId, mode as 'basic' | 'standard_a' | 'standard_b');
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to set user model mode', error });
        }
    }
}
