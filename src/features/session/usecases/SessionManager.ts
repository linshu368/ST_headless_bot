import fs from 'fs';
import path from 'path';
import config from '../../../platform/config.js';
import { STEngineAdapter } from '../../../infrastructure/st_matrix/STEngineAdapter.js';
import { createFetchInterceptor } from '../../../infrastructure/networking/FetchInterceptor.js';

/**
 * Standard OpenAI Message Format (Layer 2 Pure)
 */
export interface OpenAIMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    // Layer 2 doesn't care about ST specific fields like 'send_date' or 'force_avatar'
}

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

    constructor() {
        // Start cleanup job
        this.cleanupInterval = setInterval(() => this._cleanupStaleSessions(), 60 * 1000);
    }

    /**
     * Get an existing session or create a new one
     */
    async getOrCreateSession(userId: string): Promise<ChatSession> {
        let session = this.sessions.get(userId);

        if (session) {
            session.lastActive = Date.now();
            return session;
        }

        console.log(`[SessionManager] Creating new session for user: ${userId}`);
        session = await this._createSession(userId);
        this.sessions.set(userId, session);
        return session;
    }

    /**
     * Internal: Create a new session with default character
     */
    private async _createSession(userId: string): Promise<ChatSession> {
        // 1. Load Character (Mock Data Source)
        const charPath = path.join(config.st.mockDataPath, 'seraphina_v2.json');
        if (!fs.existsSync(charPath)) {
            throw new Error(`Character file not found: ${charPath}`);
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
        const history: OpenAIMessage[] = [];
        
        // Add System Prompt (Optional, ST usually handles this via character card)
        // history.push({ role: 'system', content: character.description });

        // Add First Message
        if (character.first_mes) {
            history.push({
                role: 'assistant',
                content: character.first_mes
            });
        }

        return {
            sessionId: `sess_${userId}_${Date.now()}`,
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
                console.log(`[SessionManager] Cleaning up stale session for user: ${userId}`);
                // Optional: session.engine.destroy() if implemented
                this.sessions.delete(userId);
            }
        }
    }

    /**
     * Manually destroy a session (e.g., /reset command)
     */
    destroySession(userId: string): void {
        if (this.sessions.has(userId)) {
            console.log(`[SessionManager] Manually destroying session for user: ${userId}`);
            this.sessions.delete(userId);
        }
    }
}

