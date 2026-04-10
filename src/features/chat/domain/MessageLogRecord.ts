/** Which credit account was charged */
export type CreditAccount = 'main_credits' | 'bonus_credits';

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
    session_id?: string;
    accept_at?: string; // ISO 8601 – when the bot received the user message
    credits_deducted?: number | null; // >0: amount deducted, 0: skipped, null: deduction failed
    credits_account?: CreditAccount | null; // which account was charged; null when deduction failed or skipped
    /** [Step5c] New field: Snapshot of user preferences at the time of message */
    user_preferences?: any;
    // id and created_at are handled by DB
}
