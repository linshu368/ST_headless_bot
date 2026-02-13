/**
 * RuntimeConfigService - 运行时配置中心
 * 
 * 链路：Memory Cache → Redis (60s TTL) → Supabase (source of truth) → Static Fallback
 * 
 * 设计目标：
 * 1. 运营在 Supabase 后台修改参数，60 秒内自动生效
 * 2. 不影响用户对话响应速度（内存缓存 0ms，Redis ~10ms）
 * 3. 三层降级保障：Redis 挂了走 Supabase，Supabase 也挂了走静态默认值
 */

import config from '../../platform/config.js';
import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';
import type { AIChannelConfig, TierMappingConfig } from '../../types/config.js';

const COMPONENT = 'RuntimeConfig';
const REDIS_KEY_PREFIX = 'runtime_config';
const CACHE_TTL_MS = 60_000; // 60 seconds

// === Exported Types ===

export interface AIConfigSourceData {
    channels: AIChannelConfig;
    tier_mapping: TierMappingConfig;
}

// === Internal Types ===

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

interface UpstashResponse {
    result?: unknown;
    error?: string;
}

// === Service ===

export class RuntimeConfigService {
    private static instance: RuntimeConfigService;
    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly memCache: Map<string, CacheEntry<unknown>> = new Map();
    private readonly redisEnabled: boolean;

    private constructor() {
        this.baseUrl = (config.redis.restUrl || '').replace(/\/+$/, '');
        this.headers = {
            Authorization: `Bearer ${config.redis.token}`,
            'Content-Type': 'application/json',
        };
        this.redisEnabled = Boolean(config.redis.restUrl && config.redis.token);

        logger.info({
            kind: 'sys',
            component: COMPONENT,
            message: 'RuntimeConfigService initialized',
            meta: { redisEnabled: this.redisEnabled, supabaseEnabled: Boolean(supabase) },
        });
    }

    static getInstance(): RuntimeConfigService {
        if (!RuntimeConfigService.instance) {
            RuntimeConfigService.instance = new RuntimeConfigService();
        }
        return RuntimeConfigService.instance;
    }

    // =============================================
    // Public: Generic get with 3-layer fallback
    // =============================================

    async get<T>(key: string, fallback: T): Promise<T> {
        // Layer 1: In-memory cache (0ms)
        const memEntry = this.memCache.get(key);
        if (memEntry && Date.now() < memEntry.expiresAt) {
            return memEntry.value as T;
        }

        // Layer 2: Redis cache (~10ms via Upstash REST)
        if (this.redisEnabled) {
            try {
                const redisValue = await this.redisGet(key);
                if (redisValue !== null) {
                    const parsed = JSON.parse(redisValue) as T;
                    this.memCache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
                    return parsed;
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis read failed for ${key}`, error });
            }
        }

        // Layer 3: Supabase (source of truth, ~100-500ms)
        if (supabase) {
            try {
                const { data, error } = await supabase
                    .from('runtime_config')
                    .select('value')
                    .eq('key', key)
                    .single();

                if (!error && data) {
                    const value = data.value as T;

                    // Write back to Redis (fire-and-forget)
                    if (this.redisEnabled) {
                        this.redisSetEx(key, JSON.stringify(value), Math.floor(CACHE_TTL_MS / 1000)).catch(err => {
                            logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis write-back failed for ${key}`, error: err });
                        });
                    }

                    this.memCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
                    logger.info({ kind: 'infra', component: COMPONENT, message: `Config loaded from Supabase: ${key}` });
                    return value;
                }

                if (error) {
                    logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase query error for ${key}`, meta: { error: error.message } });
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase read failed for ${key}`, error });
            }
        }

        // Layer 4: Static fallback (from config.ts / .env)
        logger.info({ kind: 'infra', component: COMPONENT, message: `Using static fallback for: ${key}` });
        return fallback;
    }

    // =============================================
    // Public: Convenience Methods (type-safe)
    // =============================================

    /** 获取 AI 通道配置 (channels + tier_mapping) */
    async getAIConfigSource(): Promise<AIConfigSourceData> {
        return this.get<AIConfigSourceData>('ai_config_source', config.ai_config_source);
    }

    /** 获取最大历史对话条数 */
    async getMaxHistoryItems(): Promise<number> {
        return this.get<number>('max_history_items', config.redis.maxHistoryItems);
    }

    /** 获取增强系统指令 */
    async getSystemInstructions(): Promise<string> {
        return this.get<string>('system_instructions', config.telegram.instruction_enhancement.system_instructions);
    }

    /** 获取 Bot 启动欢迎语 */
    async getWelcomeMessage(): Promise<string> {
        return this.get<string>('welcome_message', config.telegram.welcome_message);
    }

    // =============================================
    // Private: Redis Operations (Upstash REST API)
    // =============================================

    private async redisGet(key: string): Promise<string | null> {
        const redisKey = encodeURIComponent(`${REDIS_KEY_PREFIX}:${key}`);
        const url = `${this.baseUrl}/get/${redisKey}`;

        const response = await fetch(url, { headers: this.headers });
        if (!response.ok) {
            throw new Error(`Redis GET ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as UpstashResponse;
        if (data.error) {
            throw new Error(`Redis error: ${data.error}`);
        }

        const result = data.result;
        if (result === null || result === undefined) {
            return null;
        }
        return typeof result === 'string' ? result : JSON.stringify(result);
    }

    private async redisSetEx(key: string, value: string, ttlSeconds: number): Promise<void> {
        const redisKey = `${REDIS_KEY_PREFIX}:${key}`;

        // Use Upstash REST API command format: POST body as JSON array
        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(['SET', redisKey, value, 'EX', String(ttlSeconds)]),
        });

        if (!response.ok) {
            throw new Error(`Redis SET ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as UpstashResponse;
        if (data.error) {
            throw new Error(`Redis error: ${data.error}`);
        }
    }
}

/** 全局单例，业务代码直接 import 使用 */
export const runtimeConfig = RuntimeConfigService.getInstance();
