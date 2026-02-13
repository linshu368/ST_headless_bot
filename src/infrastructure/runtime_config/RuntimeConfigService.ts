/**
 * RuntimeConfigService - 运行时配置中心
 * 
 * 链路：Redis (60s TTL) → Supabase (source of truth) → Static Fallback
 * 说明：后台定时从 Supabase 刷新 Redis（每 60s），确保缓存持续更新
 * 
 * 设计目标：
 * 1. 运营在 Supabase 后台修改参数，60 秒内自动生效
 * 2. 不影响用户对话响应速度（Redis ~10ms）
 * 3. 两层降级保障：Redis 挂了走 Supabase，Supabase 也挂了走静态默认值
 */

import config from '../../platform/config.js';
import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';
import type { AIChannelConfig, TierMappingConfig } from '../../types/config.js';
import { RuntimeConfigSchema } from './RuntimeConfigSchema.js';

const COMPONENT = 'RuntimeConfig';
const REDIS_KEY_PREFIX = 'runtime_config';
const CACHE_TTL_MS = 60_000; // 60 seconds
const REFRESH_INTERVAL_MS = 60_000; // 60 seconds
const LOCK_KEY_PREFIX = 'runtime_config_lock';
const LOCK_TTL_MS = 5_000; // short lock to avoid herd
const LOCK_WAIT_MS = 100;
const LOCK_WAIT_RETRIES = 5;

// === Exported Types ===

export interface AIConfigSourceData {
    channels: AIChannelConfig;
    tier_mapping: TierMappingConfig;
}

interface UpstashResponse {
    result?: unknown;
    error?: string;
}

interface CachedRuntimeConfigPayload<T> {
    __runtime_config_meta?: {
        version: number | null;
        updated_at: string | null;
    } | null;
    value: T;
}

// === Service ===

export class RuntimeConfigService {
    private static instance: RuntimeConfigService;
    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly redisEnabled: boolean;
    private refreshTimer: NodeJS.Timeout | null = null;
    private refreshInFlight = false;

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

        // 仅当 Redis + Supabase 同时可用时，启动后台刷新
        if (this.redisEnabled && supabase) {
            this.startPeriodicRefresh();
        }
    }

    static getInstance(): RuntimeConfigService {
        if (!RuntimeConfigService.instance) {
            RuntimeConfigService.instance = new RuntimeConfigService();
        }
        return RuntimeConfigService.instance;
    }

    // =============================================
    // Public: Generic get with 2-layer fallback
    // =============================================

    async get<T>(key: string, fallback: T): Promise<T> {
        // Layer 1: Redis cache (~10ms via Upstash REST)
        if (this.redisEnabled) {
            try {
                const redisValue = await this.redisGet(key);
                if (redisValue !== null) {
                    const parsedRaw = JSON.parse(redisValue) as T | CachedRuntimeConfigPayload<T>;
                    const { value, meta } = this.extractCachedValue<T>(parsedRaw);
                    const parsed = RuntimeConfigSchema.parse<T>({
                        key,
                        value,
                        version: meta?.version ?? null,
                        updated_at: meta?.updated_at ?? null,
                    });
                    this.logConfigMeta(key, parsed.version, parsed.updated_at, 'redis');
                    return parsed.value;
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis read/parse failed for ${key}`, error });
            }
        }

        // Layer 2: Supabase (source of truth, ~100-500ms)
        if (supabase) {
            // Prevent thundering herd on cache miss
            let lockAcquired = false;
            if (this.redisEnabled) {
                lockAcquired = await this.acquireLock(key);
            }

            if (!lockAcquired && this.redisEnabled) {
                // Another instance is refreshing; wait briefly and re-check Redis
                for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
                    await this.sleep(LOCK_WAIT_MS);
                    const retryValue = await this.redisGet(key).catch(() => null);
                    if (retryValue !== null) {
                        return JSON.parse(retryValue) as T;
                    }
                }
            }

            try {
                const { data, error } = await supabase
                    .from('runtime_config')
                    .select('value,version,updated_at')
                    .eq('key', key)
                    .single();

                if (!error && data) {
                    const parsed = RuntimeConfigSchema.parse<T>({
                        key,
                        value: data.value,
                        version: data.version,
                        updated_at: data.updated_at,
                    });

                    // Write back to Redis (fire-and-forget)
                    if (this.redisEnabled) {
                        const payload = this.wrapCachedValue(parsed.value, {
                            version: parsed.version,
                            updated_at: parsed.updated_at,
                        });
                        this.redisSetEx(key, payload, Math.floor(CACHE_TTL_MS / 1000)).catch(err => {
                            logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis write-back failed for ${key}`, error: err });
                        });
                    }
                    logger.info({ kind: 'infra', component: COMPONENT, message: `Config loaded from Supabase: ${key}` });
                    this.logConfigMeta(key, parsed.version, parsed.updated_at, 'supabase');
                    return parsed.value;
                }

                if (error) {
                    logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase query error for ${key}`, meta: { error: error.message } });
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase read failed for ${key}`, error });
            } finally {
                if (lockAcquired) {
                    this.releaseLock(key).catch(() => {});
                }
            }
        }

        // Layer 3: Static fallback (from config.ts / .env)
        logger.info({ kind: 'infra', component: COMPONENT, message: `Using static fallback for: ${key}` });
        this.logConfigMeta(key, null, null, 'fallback');
        return fallback;
    }

    // =============================================
    // Private: Periodic Refresh
    // =============================================

    private startPeriodicRefresh(): void {
        if (this.refreshTimer) return;

        // 立即尝试一次，随后按固定周期刷新
        this.refreshAllToRedis().catch(() => {});
        this.refreshTimer = setInterval(() => {
            this.refreshAllToRedis().catch(() => {});
        }, REFRESH_INTERVAL_MS);
    }

    private async refreshAllToRedis(): Promise<void> {
        if (!supabase || !this.redisEnabled) return;
        if (!(await this.acquireLock('refresh_all'))) return;
        if (this.refreshInFlight) return;
        this.refreshInFlight = true;

        try {
            const { data, error } = await supabase
                .from('runtime_config')
                .select('key,value,version,updated_at');

            if (error) {
                logger.warn({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Periodic refresh failed (Supabase query error)',
                    meta: { error: error.message },
                });
                return;
            }

            if (!data || data.length === 0) {
                logger.warn({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Periodic refresh found no runtime_config rows',
                });
                return;
            }

            const ttlSeconds = Math.floor(CACHE_TTL_MS / 1000);
            for (const row of data) {
                if (!row?.key) continue;
                try {
                    const parsed = RuntimeConfigSchema.parse({
                        key: row.key,
                        value: row.value,
                        version: row.version,
                        updated_at: row.updated_at,
                    });
                    const payload = this.wrapCachedValue(parsed.value, {
                        version: parsed.version,
                        updated_at: parsed.updated_at,
                    });
                    await this.redisSetEx(row.key, payload, ttlSeconds);
                } catch (error) {
                    logger.warn({
                        kind: 'infra',
                        component: COMPONENT,
                        message: `Periodic refresh skipped invalid config: ${row.key}`,
                        error,
                    });
                }
            }

            logger.info({
                kind: 'infra',
                component: COMPONENT,
                message: 'Periodic refresh completed',
                meta: { count: data.length },
            });
        } catch (error) {
            logger.warn({
                kind: 'infra',
                component: COMPONENT,
                message: 'Periodic refresh failed',
                error,
            });
        } finally {
            this.refreshInFlight = false;
            this.releaseLock('refresh_all').catch(() => {});
        }
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

    /** 获取历史截断低水位线 */
    async getHistoryRetentionCount(): Promise<number> {
        return this.get<number>('history_retention_count', config.redis.historyRetentionCount);
    }

    /** 获取会话过期时间（分钟） */
    async getSessionTimeoutMinutes(): Promise<number> {
        return this.get<number>('session_timeout_minutes', config.session.timeoutMinutes);
    }

    /** 获取默认角色 ID */
    async getDefaultRoleId(): Promise<string> {
        return this.get<string>('default_role_id', config.supabase.defaultRoleId);
    }

    /** 获取增强系统指令 */
    async getSystemInstructions(): Promise<string> {
        return this.get<string>('system_instructions', config.telegram.instruction_enhancement.system_instructions);
    }

    /** 获取 Bot 启动欢迎语 */
    async getWelcomeMessage(): Promise<string> {
        return this.get<string>('welcome_message', config.telegram.welcome_message);
    }

    /** 获取流式生成分块间隔超时（ms） */
    async getStreamInterChunkTimeout(): Promise<number> {
        return this.get<number>('ai_stream_inter_chunk_timeout', config.timeouts.interChunk);
    }

    /** 获取流式生成总超时（ms） */
    async getStreamTotalTimeout(): Promise<number> {
        return this.get<number>('ai_stream_total_timeout', config.timeouts.total);
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

    private wrapCachedValue<T>(value: T, meta: { version: number | null; updated_at: string | null }): string {
        return JSON.stringify({
            __runtime_config_meta: meta,
            value,
        } satisfies CachedRuntimeConfigPayload<T>);
    }

    private extractCachedValue<T>(value: T | CachedRuntimeConfigPayload<T>): {
        value: T;
        meta: { version: number | null; updated_at: string | null } | null;
    } {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const obj = value as CachedRuntimeConfigPayload<T>;
            if ('__runtime_config_meta' in obj && 'value' in obj) {
                const meta = obj.__runtime_config_meta ?? null;
                return { value: obj.value as T, meta };
            }
        }
        return { value: value as T, meta: null };
    }

    private logConfigMeta(key: string, version: number | null, updated_at: string | null, source: 'redis' | 'supabase' | 'fallback'): void {
        logger.info({
            kind: 'infra',
            component: COMPONENT,
            message: 'Runtime config meta',
            meta: { key, version, updated_at, source },
        });
    }

    private async acquireLock(key: string): Promise<boolean> {
        if (!this.redisEnabled) return false;
        const lockKey = `${LOCK_KEY_PREFIX}:${key}`;

        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify([
                    'SET',
                    lockKey,
                    String(Date.now()),
                    'NX',
                    'PX',
                    String(LOCK_TTL_MS),
                ]),
            });

            if (!response.ok) {
                throw new Error(`Redis SETNX ${response.status}: ${await response.text()}`);
            }

            const data = (await response.json()) as UpstashResponse;
            if (data.error) {
                throw new Error(`Redis error: ${data.error}`);
            }

            return data.result === 'OK' || data.result === 1;
        } catch (error) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Lock acquire failed', error });
            return false;
        }
    }

    private async releaseLock(key: string): Promise<void> {
        const lockKey = `${LOCK_KEY_PREFIX}:${key}`;
        await fetch(this.baseUrl, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(['DEL', lockKey]),
        }).catch(() => {});
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }
}

/** 全局单例，业务代码直接 import 使用 */
export const runtimeConfig = RuntimeConfigService.getInstance();
