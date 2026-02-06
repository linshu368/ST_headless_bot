import dotenv from 'dotenv';
import path from 'path';
import type { AIChannelConfig, TierMappingConfig } from '../types/config.js';

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
        instruction_enhancement: {
            system_instructions: string;
        };
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
    supabase: {
        url: string;
        key: string;
    };
    ai_config_source: {
        channels: AIChannelConfig;
        tier_mapping: TierMappingConfig;
        // instructions: Removed as logic is simplified to single system_instruction
    };
    timeouts: {
        interChunk: number;
        total: number;
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
        instruction_enhancement: {
            system_instructions: process.env.SYSTEM_INSTRUCTIONS || '请尽量简短回答。',
        }
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
    supabase: {
        url: process.env.SUPABASE_URL || '',
        key: process.env.SUPABASE_KEY || '',
    },
    timeouts: {
        interChunk: Number(process.env.AI_STREAM_INTER_CHUNK_TIMEOUT || '3000'),
        total: Number(process.env.AI_STREAM_TOTAL_TIMEOUT || '15000'),
    },
    // --- Step 1: 模拟外部配置数据源 (将来替换为 Supabase) ---
    ai_config_source: {
        // 1. 通道配置表 (模拟 Supabase 'ai_channels' 表)
        channels: {
            'channel_1': [
                {
                    id: 'step_1',
                    provider: 'openai',
                    url: 'https://aifuturekey.xyz/v1/chat/completions',
                    key: process.env.PROFILE_1_KEY || '',
                    model: 'grok-4-fast-non-reasoning',
                    firstchunk_timeout: 3000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_2',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_3_KEY || '',
                    model: 'deepseek/deepseek-chat-v3.1',
                    firstchunk_timeout: 5000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_3',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_2_KEY || '',
                    model: 'google/gemini-3-flash-preview',
                    firstchunk_timeout: 10000,
                    total_timeout: 15000,
                }
            ],
            'channel_2': [
                {
                    id: 'step_1',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_3_KEY || '',
                    model: 'deepseek/deepseek-chat-v3.1',
                    firstchunk_timeout: 5000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_2',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_3_KEY || '',
                    model: 'deepseek/deepseek-chat-v3.1',
                    firstchunk_timeout: 5000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_3',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_2_KEY || '',
                    model: 'google/gemini-3-flash-preview',
                    firstchunk_timeout: 10000,
                    total_timeout: 15000,
                }
            ],
            'channel_3': [
                {
                    id: 'step_1',
                    provider: 'openai',
                    url: 'https://api.siliconflow.cn/v1/chat/completions',
                    key: process.env.PROFILE_4_KEY || '',
                    model: 'Pro/deepseek-ai/DeepSeek-V3.1-Terminus',
                    firstchunk_timeout: 10000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_2',
                    provider: 'openai',
                    url: 'https://api.siliconflow.cn/v1/chat/completions',
                    key: process.env.PROFILE_4_KEY || '',
                    model: 'Pro/deepseek-ai/DeepSeek-V3.1-Terminus',
                    firstchunk_timeout: 10000,
                    total_timeout: 15000,
                },
                {
                    id: 'step_3',
                    provider: 'openai',
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    key: process.env.PROFILE_2_KEY || '',
                    model: 'google/gemini-3-flash-preview',
                    firstchunk_timeout: 10000,
                    total_timeout: 15000,
                }
            ]
        },
        // 2. 映射表 (模拟 Supabase 'tier_mapping' 表)
        tier_mapping: {
            'basic': 'channel_1',
            'standard_a': 'channel_2',
            'standard_b': 'channel_3',
        },
    }
};

export default config;