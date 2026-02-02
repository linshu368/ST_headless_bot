import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
    telegram: {
        token: string;
        proxy: {
            scheme: string;
            host: string;
            port: number;
        } | null;
    };
    openai: {
        apiKey: string;
        apiUrl: string;
        model: string;
    };
    st: {
        mockDataPath: string;
    };
    logging: {
        level: LogLevel;
        dir: string;
    };
    redis: {
        restUrl: string;
        token: string;
        namespace: string;
        maxHistoryItems: number;
        historyRetentionCount: number;
    };
    ai_config_source: {
        profiles: Record<string, any>;
        pipelines: Record<string, string[]>;
        tier_mapping: Record<string, string>;
    };
}

const config: Config = {
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN || '',
        proxy: process.env.TELEGRAM_PROXY_SCHEME
            && process.env.TELEGRAM_PROXY_HOST
            && process.env.TELEGRAM_PROXY_PORT
            ? {
                scheme: process.env.TELEGRAM_PROXY_SCHEME,
                host: process.env.TELEGRAM_PROXY_HOST,
                port: Number(process.env.TELEGRAM_PROXY_PORT),
            }
            : null,
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        apiUrl: process.env.OPENAI_API_URL || 'https://aifuturekey.xyz/v1/chat/completions',
        model: process.env.OPENAI_MODEL || 'grok-4-fast-non-reasoning',
    },
    st: {
        mockDataPath: path.resolve(process.cwd(), 'src/infrastructure/mock_data'),
    },
    logging: {
        level: (process.env.LOG_LEVEL as LogLevel) || 'info',
        dir: process.env.LOG_DIR || path.resolve(process.cwd(), 'logs'),
    },
    redis: {
        restUrl: process.env.UPSTASH_REDIS_REST_URL || '',
        token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
        namespace: process.env.REDIS_SESSION_NAMESPACE || 'session',
        maxHistoryItems: Number(process.env.MAX_HISTORY_ITEMS || '150'),
        historyRetentionCount: Number(
            process.env.HISTORY_RETENTION_COUNT || process.env.MAX_HISTORY_ITEMS || '150'
        ),
    },
    // --- Step 1: 模拟外部配置数据源 (将来替换为 Supabase) ---
    ai_config_source: {
        // 1. 原子 Profile (Variables)
        profiles: {
            'grok_fast': {
                id: 'grok_fast',
                provider: 'openai',
                url: 'https://api.openai.com/v1', // Placeholder for Grok
                key: process.env.CHANNEL_1_KEY || '', // 临时复用 env
                model: 'grok-beta',
                timeout: 3000,
            },
            'grok_retry': {
                id: 'grok_retry',
                provider: 'openai',
                url: 'https://api.openai.com/v1',
                key: process.env.CHANNEL_1_KEY || '',
                model: 'grok-beta',
                timeout: 10000,
            },
            'gemini_flash': {
                id: 'gemini_flash',
                provider: 'openai',
                url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
                key: process.env.CHANNEL_2_KEY || '',
                model: 'gemini-1.5-flash',
                timeout: 5000,
            },
            'deepseek_v3': {
                id: 'deepseek_v3',
                provider: 'openai',
                url: 'https://api.deepseek.com',
                key: process.env.CHANNEL_3_KEY || '',
                model: 'deepseek-chat',
                timeout: 10000,
            }
        },
        // 2. 通道 Pipeline (Sequence)
        pipelines: {
            'channel_1': ['grok_fast', 'gemini_flash', 'grok_retry'],
            'channel_2': ['gemini_flash', 'gemini_flash', 'grok_retry'],
            'channel_3': ['deepseek_v3', 'deepseek_v3', 'grok_retry'],
        },
        // 3. 业务策略 (Mapping)
        tier_mapping: {
            'basic': 'channel_1',
            'standard': 'channel_2',
            'premium': 'channel_3',
        } as Record<string, string>
    }
};

export default config;
