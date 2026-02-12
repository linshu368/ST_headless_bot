export type SessionMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
};

export interface SessionStore {
    getMessages(sessionId: string): Promise<SessionMessage[]>;
    setMessages(sessionId: string, messages: SessionMessage[]): Promise<void>;
    appendMessage(sessionId: string, message: SessionMessage): Promise<void>;

    getCurrentSessionId(userId: string): Promise<string | null>;
    setCurrentSessionId(userId: string, sessionId: string): Promise<void>;
    getLastSessionId(userId: string): Promise<string | null>;
    setLastSessionId(userId: string, sessionId: string): Promise<void>;

    getSessionData(sessionId: string): Promise<Record<string, unknown> | null>;
    setSessionData(sessionId: string, data: Record<string, unknown>): Promise<void>;

    getUserModelMode(userId: string): Promise<'basic' | 'standard_a' | 'standard_b'>;
    setUserModelMode(userId: string, mode: 'basic' | 'standard_a' | 'standard_b'): Promise<void>;

    /** User-level last active timestamp (ms) for session expiry */
    getLastActiveTime(userId: string): Promise<number | null>;
    setLastActiveTime(userId: string, timestamp: number): Promise<void>;
}
