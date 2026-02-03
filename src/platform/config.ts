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
        // 1. 原子 Profile (Variables) - 使用抽象 ID
        profiles: {
            'profile_1': {
                id: 'profile_1',
                provider: 'openai',
                url: 'https://aifuturekey.xyz/v1/chat/completions',
                key: process.env.PROFILE_1_KEY || '',
                model: 'grok-4-fast-non-reasoning',
                timeout: 3000,
            },
            'profile_2': {
                id: 'profile_2',
                provider: 'openai',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                key: process.env.PROFILE_2_KEY || '',
                model: 'google/gemini-3-flash-preview',
                timeout: 10000,
            },
            'profile_3': {
                id: 'profile_3',
                provider: 'openai',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                key: process.env.PROFILE_3_KEY || '',
                model: 'deepseek/deepseek-chat-v3.1',
                timeout: 5000,
            },
            'profile_4': {
                id: 'profile_4',
                provider: 'openai',
                url: 'https://api.siliconflow.cn/v1/chat/completions',
                key: process.env.PROFILE_4_KEY || '',
                model: 'Pro/deepseek-ai/DeepSeek-V3.1-Terminus',
                timeout: 10000,
            }
        },
        // 2. 通道 Pipeline (Sequence)
        pipelines: {
            'channel_1': ['profile_1', 'profile_3', 'profile_2'],
            'channel_2': ['profile_3', 'profile_3', 'profile_2'],
            'channel_3': ['profile_4', 'profile_4', 'profile_2'],
        },
        // 3. 业务策略 (Mapping) - 使用新枚举值
        tier_mapping: {
            'basic': 'channel_1',
            'standard_a': 'channel_2',
            'standard_b': 'channel_3',
        } as Record<string, string>
    }
};

export default config;
