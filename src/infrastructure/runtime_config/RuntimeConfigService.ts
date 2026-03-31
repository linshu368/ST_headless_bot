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
import type { CreditsPlan } from '../../types/payment.js';
import { RuntimeConfigSchema } from './RuntimeConfigSchema.js';
import type { StreamScheduleConfig } from '../../features/chat/rules/streamingSchedule.js';
import { feishuAlert, AlertType } from '../alerts/FeishuAlertService.js';

const COMPONENT = 'RuntimeConfig';
const REDIS_KEY_PREFIX = 'runtime_config';

const ALERT_CONFIG_KEYS = new Set(['ai_config_source', 'payment_credits_plans']);

/** 支付文案模板的静态降级默认值（Layer 3 兜底） */
const PAYMENT_TEMPLATE_FALLBACKS: Record<string, string> = {
    payment_recharge_welcome: `💰 **星尘充值**

星尘是您与 AI 角色对话的能量来源。

📌 **支持的支付方式：**
💳 支付宝 - 扫码即付
💚 微信支付 - 扫码即付

请选择支付方式：`,

    payment_order_created: `✅ **订单已创建**

订单将于15分钟后关闭哦~~
--------------------------------------
📋 订单信息：
• 订单号：\`{{orderId}}\`
• 充值金额：{{amount}}元
• 支付方式：{{methodName}}
--------------------------------------

点击下方按钮开始支付 ⬇️`,

    payment_order_expired: '超时未支付，本次订单`{{orderId}}`已取消',

    payment_order_pending: `⏳ 等待支付

订单将于15分钟后关闭哦~~
------------------------------------
📋 订单信息：
• 订单号：\`{{orderId}}\`
{{#if methodName}}• 支付方式：{{methodName}}
{{/if}}{{#if amount}}• 支付金额：{{amount}}元
{{/if}}------------------------------------
（如果客官已经支付完成，请稍等3分钟哦，后台正加紧为您补充星尘）`,

    payment_order_failed: '❌ 查询失败\n\n📋 订单号：`{{orderId}}`\n\n请稍后再试。',

    payment_success: `✅ **充值成功！**

💰 充值金额：¥{{amount}}
📋 订单号：\`{{orderId}}\`
💳 支付方式：{{methodName}}
✨ 获得星尘：{{mainCredits}}
{{#if bonusLine}}🎁 额外赠送：{{bonusLine}}
{{/if}}
感谢您的支持！`,
};
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
    tier_costs?: Record<string, number>;
}

interface UpstashResponse {
    result?: unknown;
    error?: string;
}

interface CachedRuntimeConfigPayload<T> {
    __runtime_config_meta?: {
        version: number | null;
        updated_at: string | null;
        text_value?: string | null;
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

    private supabaseConsecutiveFailures = 0;
    private readonly SUPABASE_FAILURE_THRESHOLD = 3;
    private supabaseConnectionLostAlerted = false;

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
                        text_value: meta?.text_value,
                        version: meta?.version ?? null,
                        updated_at: meta?.updated_at ?? null,
                    });
                    this.logConfigMeta(key, parsed.version, parsed.updated_at, 'redis');
                    this.logConfigValue(key, parsed.value, 'redis');
                    return parsed.value;
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis read/parse failed for ${key}`, error });
                if (ALERT_CONFIG_KEYS.has(key)) {
                    feishuAlert.sendP1({
                        alertType: AlertType.CHANNEL_CONFIG_PARSE_ERROR,
                        message: `运行时配置 "${key}" 从 Redis 读取/解析失败，将尝试 Supabase 降级`,
                        error,
                        meta: { configKey: key, source: 'redis' },
                    });
                }
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
                    .select('value,text_value,version,updated_at')
                    .eq('key', key)
                    .single();

                if (!error && data) {
                    const parsed = RuntimeConfigSchema.parse<T>({
                        key,
                        value: data.value,
                        text_value: data.text_value,
                        version: data.version,
                        updated_at: data.updated_at,
                    });

                    // Write back to Redis (fire-and-forget)
                    if (this.redisEnabled) {
                        const payload = this.wrapCachedValue(parsed.value, {
                            version: parsed.version,
                            updated_at: parsed.updated_at,
                            text_value: data.text_value,
                        });
                        this.redisSetEx(key, payload, Math.floor(CACHE_TTL_MS / 1000)).catch(err => {
                            logger.warn({ kind: 'infra', component: COMPONENT, message: `Redis write-back failed for ${key}`, error: err });
                        });
                    }
                    logger.info({ kind: 'infra', component: COMPONENT, message: `Config loaded from Supabase: ${key}` });
                    this.logConfigMeta(key, parsed.version, parsed.updated_at, 'supabase');
                    this.logConfigValue(key, parsed.value, 'supabase');
                    return parsed.value;
                }

                if (error) {
                    logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase query error for ${key}`, meta: { error: error.message } });
                }
            } catch (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Supabase read failed for ${key}`, error });
                if (ALERT_CONFIG_KEYS.has(key)) {
                    feishuAlert.sendP1({
                        alertType: AlertType.CHANNEL_CONFIG_PARSE_ERROR,
                        message: `运行时配置 "${key}" 从 Supabase 读取/解析失败，将降级到静态兜底值`,
                        error,
                        meta: { configKey: key, source: 'supabase' },
                    });
                }
            } finally {
                if (lockAcquired) {
                    this.releaseLock(key).catch(() => {});
                }
            }
        }

        // Layer 3: Static fallback (from config.ts / .env)
        logger.info({ kind: 'infra', component: COMPONENT, message: `Using static fallback for: ${key}` });
        this.logConfigMeta(key, null, null, 'fallback');
        this.logConfigValue(key, fallback, 'fallback');
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
        // Allow the process to exit even if this timer is still active.
        // Critical for short-lived CLI scripts (e.g. ops/git hooks) that
        // import RuntimeConfigService but should not be kept alive by it.
        this.refreshTimer.unref();
    }

    private _checkSupabaseConnectionLost(error: unknown): void {
        if (this.supabaseConsecutiveFailures >= this.SUPABASE_FAILURE_THRESHOLD
            && !this.supabaseConnectionLostAlerted) {
            this.supabaseConnectionLostAlerted = true;
            feishuAlert.sendP0({
                alertType: AlertType.SUPABASE_CONNECTION_LOST,
                message: `Supabase 定时刷新连续 ${this.supabaseConsecutiveFailures} 个周期失败（~${this.supabaseConsecutiveFailures} 分钟），判定连接断开`,
                error,
                meta: { consecutiveFailures: this.supabaseConsecutiveFailures },
            });
        }
    }

    private async refreshAllToRedis(): Promise<void> {
        if (!supabase || !this.redisEnabled) return;
        if (!(await this.acquireLock('refresh_all'))) return;
        if (this.refreshInFlight) return;
        this.refreshInFlight = true;

        try {
            const { data, error } = await supabase
                .from('runtime_config')
                .select('key,value,text_value,version,updated_at');

            if (error) {
                this.supabaseConsecutiveFailures++;
                this._checkSupabaseConnectionLost(new Error(error.message));
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

            this.supabaseConsecutiveFailures = 0;
            if (this.supabaseConnectionLostAlerted) {
                this.supabaseConnectionLostAlerted = false;
                logger.info({ kind: 'sys', component: COMPONENT, message: 'Supabase connection recovered' });
            }

            const ttlSeconds = Math.floor(CACHE_TTL_MS / 1000);
            for (const row of data) {
                if (!row?.key) continue;
                try {
                    const parsed = RuntimeConfigSchema.parse({
                        key: row.key,
                        value: row.value,
                        text_value: row.text_value,
                        version: row.version,
                        updated_at: row.updated_at,
                    });
                    const payload = this.wrapCachedValue(parsed.value, {
                        version: parsed.version,
                        updated_at: parsed.updated_at,
                        text_value: row.text_value,
                    });
                    await this.redisSetEx(row.key, payload, ttlSeconds);
                } catch (error) {
                    logger.warn({
                        kind: 'infra',
                        component: COMPONENT,
                        message: `Periodic refresh skipped invalid config: ${row.key}`,
                        error,
                    });
                    if (ALERT_CONFIG_KEYS.has(row.key)) {
                        feishuAlert.sendP1({
                            alertType: AlertType.CHANNEL_CONFIG_PARSE_ERROR,
                            message: `定时刷新：配置 "${row.key}" 解析失败，该行已跳过`,
                            error,
                            meta: { configKey: row.key, source: 'periodic_refresh' },
                        });
                    }
                }
            }

            logger.info({
                kind: 'infra',
                component: COMPONENT,
                message: 'Periodic refresh completed',
                meta: { count: data.length },
            });
        } catch (error) {
            this.supabaseConsecutiveFailures++;
            this._checkSupabaseConnectionLost(error);
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

    /** 获取积分不足提示文案 */
    async getInsufficientCreditsMessage(): Promise<string> {
        return this.get<string>('insufficient_credits_message', '星尘不足啦，唤醒更多星尘，让故事继续......');
    }

    /** 获取客服帮助文案 */
    async getCustomerServiceMessage(): Promise<string> {
        const fallback = `❓ **帮助中心**

📚 **功能说明：**

💬 **对话功能**
• 直接发送消息与AI角色对话

💾 **存档功能**
• 点击对话下方的 [💾 保存对话] 可保存当前进度
• 点击 [🗂 历史聊天] 可浏览和恢复存档

👤 **个人中心**
• 点击“👤个人中心” 可切换AI模型

💡 更多功能开发中，敬请期待...`;
        return this.get<string>('customer_service_message', fallback);
    }

    /** 获取 P0 崩溃级兜底文案 */
    async getP0FallbackMessage(): Promise<string> {
        return this.get<string>('fallback_message_p0', config.fallbackMessages.p0);
    }

    /** 获取 P1 级兜底文案 */
    async getP1FallbackMessage(): Promise<string> {
        return this.get<string>('fallback_message_p1', config.fallbackMessages.p1);
    }

    /** 获取流式首次上屏字符数 */
    async getStreamingFirstUpdateChars(): Promise<number> {
        return this.get<number>('streaming_first_update_chars', config.streaming.firstUpdateChars);
    }

    /** 获取流式常规上屏间隔（秒） */
    async getStreamingRegularUpdateIntervalSec(): Promise<number> {
        return this.get<number>('streaming_regular_update_interval_sec', config.streaming.regularUpdateIntervalSec);
    }

    /** 获取流式上屏调度配置（聚合） */
    async getStreamScheduleConfig(): Promise<StreamScheduleConfig> {
        const [firstUpdateChars, regularUpdateIntervalSec] = await Promise.all([
            this.getStreamingFirstUpdateChars(),
            this.getStreamingRegularUpdateIntervalSec(),
        ]);
        return { firstUpdateChars, regularUpdateIntervalSec };
    }

    /** 获取支付文案模板（带 {{var}} 占位符的原始模板） */
    async getPaymentTemplate(key: string): Promise<string> {
        const fallback = PAYMENT_TEMPLATE_FALLBACKS[key];
        if (fallback === undefined) {
            throw new Error(`Unknown payment template key: ${key}`);
        }
        return this.get<string>(key, fallback);
    }

    /** 获取支付套餐映射表 */
    async getPaymentCreditsPlans(): Promise<CreditsPlan[]> {
        return this.get<CreditsPlan[]>('payment_credits_plans', config.payment.creditsPlans);
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

    private wrapCachedValue<T>(value: T, meta: { version: number | null; updated_at: string | null; text_value?: string | null }): string {
        return JSON.stringify({
            __runtime_config_meta: meta,
            value,
        } satisfies CachedRuntimeConfigPayload<T>);
    }

    private extractCachedValue<T>(value: T | CachedRuntimeConfigPayload<T>): {
        value: T;
        meta: { version: number | null; updated_at: string | null; text_value?: string | null } | null;
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

    private logConfigValue(key: string, value: unknown, source: 'redis' | 'supabase' | 'fallback'): void {
        logger.debug({
            kind: 'infra',
            component: COMPONENT,
            message: 'Runtime config value',
            meta: { key, source, value: this.summarizeValue(key, value) },
        });
    }

    private summarizeValue(key: string, value: unknown): unknown {
        if (key === 'ai_config_source' && value && typeof value === 'object') {
            const source = value as AIConfigSourceData;
            const channels: Record<string, Array<Record<string, unknown>>> = {};
            for (const [channelId, steps] of Object.entries(source.channels || {})) {
                channels[channelId] = Array.isArray(steps)
                    ? steps.map(step => ({
                        id: step.id,
                        provider: step.provider,
                        url: step.url,
                        model: step.model,
                        firstchunk_timeout: step.firstchunk_timeout,
                        total_timeout: step.total_timeout,
                    }))
                    : [];
            }
            return {
                channels,
                tier_mapping: source.tier_mapping,
            };
        }

        if (key === 'payment_credits_plans' && Array.isArray(value)) {
            return {
                count: value.length,
            };
        }

        if (key === 'system_instructions' || key === 'welcome_message' || key === 'customer_service_message' || key === 'insufficient_credits_message' || key.startsWith('payment_')) {
            const text = typeof value === 'string' ? value : '';
            return {
                length: text.length,
                preview: text.slice(0, 120),
            };
        }

        return value;
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
