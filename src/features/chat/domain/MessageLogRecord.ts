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
    round?: number; // context-continuous depth: accumulates within same context, resets on new chat / switch character
    full_response?: number; // seconds
    first_response_latency?: number; // seconds (time to first 5 chars)
    trace_id?: string; // links to engineering logs for root-cause analysis
    // timestamp and id are handled by DB
}
