export interface MessageLogRecord {
    user_id: string;
    role_id: string | null;
    user_input: string;
    bot_reply: string;
    instructions: string | null;
    history: string | null; // JSON string
    model_name: string | null;
    attempt_count: number | null;
    type: 'normal' | 'regenerate';
    // timestamp and id are handled by DB
}
