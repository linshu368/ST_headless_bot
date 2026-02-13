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
        welcome_message: string;
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
        defaultRoleId: string;
        roleChannelUrl: string;
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
    session: {
        timeoutMinutes: number;
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
        },
        welcome_message: process.env.WELCOME_MESSAGE || ``,
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
        defaultRoleId: process.env.DEFAULT_ROLE_ID || '2111485095933381',
        roleChannelUrl: process.env.ROLE_CHANNEL_URL || 'https://t.me/ai_role_list',
    },
    timeouts: {
        interChunk: Number(process.env.AI_STREAM_INTER_CHUNK_TIMEOUT || '3000'),
        total: Number(process.env.AI_STREAM_TOTAL_TIMEOUT || '15000'),
    },
    session: {
        timeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES || '30'),
    },
    // --- 运行时配置 (已迁移至 Supabase runtime_config 表) ---
    // 以下为静态 fallback 默认值，仅在 Supabase + Redis 均不可用时启用
    // 正常运行时由 RuntimeConfigService 从 Supabase → Redis → 此处 三层获取
    ai_config_source: {
        // 1. 通道配置表 (Fallback: 正式数据在 Supabase runtime_config.ai_config_source)
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
        // 2. 映射表 (Fallback: 正式数据在 Supabase runtime_config.ai_config_source.tier_mapping)
        tier_mapping: {
            'tier_1': 'channel_1',
            'tier_2': 'channel_2',
            'tier_3': 'channel_3',
            'tier_4': 'channel_3'
        },
    }
};

export default config;