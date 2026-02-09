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
     * Helper: Load character data (Supabase > Mock)
     */
    private async _loadCharacter(roleId?: string): Promise<any> {
        let character: any = null;

        // 1. Try Supabase if roleId provided
        if (roleId) {
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

        // Determine Role ID from Session Data
        const currentRoleId = existingSessionData?.role_id as string | undefined;
        const character = await this._loadCharacter(currentRoleId);

        const session = await this._createSession(userId, character, existingSessionId, existingHistory, existingSessionData);
        return session;
    }

    /**
     * Internal: Create a new session with provided character
     */
    private async _createSession(
        userId: string,
        character: any,
        existingSessionId?: string | null,
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
                    // character_name removed as requested (use role_id as unique identifier)
                    role_id: character.extensions?.role_id,
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

    /**
     * Switch character for the current user
     * @param userId User ID
     * @param roleId Target Role ID
     * @returns New Character Data
     */
    async switchCharacter(userId: string, roleId: string): Promise<any> {
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Switching character', meta: { userId, roleId } });

        // 1. Load New Character
        let character = await this._loadCharacter(roleId);
        
        // If loaded character doesn't match requested roleId (fallback occurred), try default
        const loadedRoleId = character.extensions?.role_id;
        if (loadedRoleId !== roleId && roleId !== config.supabase.defaultRoleId) {
             // If we failed to load specific role, try loading default role explicitly
             // But _loadCharacter already falls back to Mock which is acceptable.
             // We just proceed with whatever character we got.
        }

        // 2. Get Current Session
        // We only need the Session ID to update Redis
        let sessionId: string | null = null;
        if (this.sessionStore) {
            sessionId = await this.sessionStore.getCurrentSessionId(userId);
        }

        if (!sessionId) {
            // No session exists, just return character (getOrCreateSession will handle it next time)
            // But we should probably preset the role_id in Redis if possible?
            // Since we can't set session data without a session ID, we defer.
            // But wait, if user sends /start role_x, they might not have a session.
            // In that case, we want to ensure next getOrCreateSession picks this role.
            // We can set a "pending role preference"? 
            // Or just create a session now?
            // Let's create a fresh session.
            await this.getOrCreateSession(userId); // This creates a session with whatever default
            // Then we recurse or just proceed?
            // Let's just proceed to update the newly created session.
            if (this.sessionStore) {
                sessionId = await this.sessionStore.getCurrentSessionId(userId);
            }
        }

        if (sessionId && this.sessionStore) {
            try {
                // 3. Clear History
                await this.sessionStore.setMessages(sessionId, []);

                // 4. Update Metadata
                // Get current data to preserve turn_count
                const currentData = await this.sessionStore.getSessionData(sessionId) || {};
                await this.sessionStore.setSessionData(sessionId, {
                    ...currentData,
                    // character_name removed
                    role_id: character.extensions?.role_id,
                    post_link: character.extensions?.post_link,
                    avatar: character.extensions?.avatar,
                    // turn_count is preserved from currentData
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
