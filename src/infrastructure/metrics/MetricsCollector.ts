import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'MetricsCollector';
const KEY_PREFIX = 'metric';
const TTL_SECONDS = 8 * 3600; // 8 小时 TTL（6 小时窗口 + 2 小时缓冲）
const MODEL_REGISTRY_KEY = `${KEY_PREFIX}:model_registry`;

/**
 * P2 报表埋点采集层：基于 Redis 原子计数器的实时指标采集
 *
 * Key 格式: metric:{counterName}:{hourBucket}
 * 例如:     metric:total_requests:2026032404  →  2026-03-24 04 时
 *
 * 按模型维度: metric:model:{modelName}:{subMetric}:{hourBucket}
 * 例如:       metric:model:grok-4:total_calls:2026032404
 *
 * 模型注册表: metric:model_registry  (Redis Set，记录所有出现过的模型名)
 *
 * 设计约束：
 * - 所有写入方法 fire-and-forget，绝不阻塞业务链路
 * - 内部兜底，永远不向外抛异常
 * - 复用现有 Upstash REST API（与 UpstashSessionStore 同源）
 * - 读取使用 pipeline 批量查询，减少 HTTP 往返
 */
class MetricsCollector {
    private static instance: MetricsCollector;
    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly enabled: boolean;

    private constructor() {
        const url = config.redis.restUrl;
        const token = config.redis.token;
        this.enabled = !!(url && token);
        this.baseUrl = url ? url.replace(/\/+$/, '') : '';
        this.headers = token
            ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
            : {};

        if (!this.enabled) {
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'MetricsCollector disabled: Redis not configured' });
        } else {
            logger.info({ kind: 'sys', component: COMPONENT, message: 'MetricsCollector initialized' });
        }
    }

    static getInstance(): MetricsCollector {
        if (!MetricsCollector.instance) {
            MetricsCollector.instance = new MetricsCollector();
        }
        return MetricsCollector.instance;
    }

    // ==================== 通用计数器（写入） ====================

    incrementTotalRequests(): void {
        this._incr('total_requests');
    }

    incrementFirstChunkGt8s(): void {
        this._incr('first_chunk_gt8s');
    }

    incrementTotalDurationGt25s(): void {
        this._incr('total_duration_gt25s');
    }

    incrementStep2Success(): void {
        this._incr('step2_success');
    }

    incrementStep3Success(): void {
        this._incr('step3_success');
    }

    incrementNoDeduction(): void {
        this._incr('no_deduction');
    }

    incrementAllStepsFailed(): void {
        this._incr('all_steps_failed');
    }

    // ==================== 按模型维度（写入） ====================

    incrementModelTotalCalls(model: string): void {
        this._incrModelMetric(model, 'total_calls');
    }

    incrementModelFirstchunkTimeout(model: string): void {
        this._incrModelMetric(model, 'firstchunk_timeout');
    }

    incrementModelError(model: string): void {
        this._incrModelMetric(model, 'error');
    }

    incrementModelTruncated(model: string): void {
        this._incrModelMetric(model, 'truncated');
    }

    // ==================== 读取（供聚合层使用） ====================

    /**
     * 读取过去 N 小时某计数器的累计值（跨 hourBucket 求和）
     */
    async sumLastHours(counterName: string, hours: number = 6): Promise<number> {
        if (!this.enabled) return 0;

        try {
            const buckets = this._getHourBuckets(hours);
            const keys = buckets.map(b => `${KEY_PREFIX}:${counterName}:${b}`);
            const values = await this._mget(keys);
            return values.reduce((sum, v) => sum + v, 0);
        } catch (err) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'sumLastHours failed', error: err, meta: { counterName, hours } });
            return 0;
        }
    }

    /**
     * 获取过去 N 小时所有模型在某子指标上的计数
     * 通过 model_registry 枚举模型名，再批量精确查询，避免 SCAN 通配符问题
     * 返回 Map<modelName, count>（count 为 0 的模型不包含）
     */
    async sumModelMetricLastHours(subMetric: string, hours: number = 6): Promise<Map<string, number>> {
        if (!this.enabled) return new Map();

        const result = new Map<string, number>();
        try {
            const modelNames = await this._smembers(MODEL_REGISTRY_KEY);
            if (modelNames.length === 0) return result;

            const buckets = this._getHourBuckets(hours);

            // 将所有模型 × 所有小时桶的 key 打平到一个数组，单次 pipeline 批量读取
            const keyModelIndex: { model: string; key: string }[] = [];
            for (const model of modelNames) {
                for (const bucket of buckets) {
                    keyModelIndex.push({
                        model,
                        key: `${KEY_PREFIX}:model:${model}:${subMetric}:${bucket}`,
                    });
                }
            }

            const values = await this._mget(keyModelIndex.map(e => e.key));

            for (let i = 0; i < keyModelIndex.length; i++) {
                const { model } = keyModelIndex[i];
                result.set(model, (result.get(model) || 0) + values[i]);
            }

            // 过滤掉 count 为 0 的模型（可能是已下线的残留注册）
            for (const [model, count] of result) {
                if (count === 0) result.delete(model);
            }
        } catch (err) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'sumModelMetricLastHours failed', error: err, meta: { subMetric } });
        }

        return result;
    }

    // ==================== 内部方法 ====================

    private _getHourBucket(): string {
        const now = new Date();
        const y = now.getFullYear();
        const M = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        return `${y}${M}${d}${h}`;
    }

    private _getHourBuckets(hours: number): string[] {
        const buckets: string[] = [];
        const now = Date.now();
        for (let i = 0; i < hours; i++) {
            const t = new Date(now - i * 3600_000);
            const y = t.getFullYear();
            const M = String(t.getMonth() + 1).padStart(2, '0');
            const d = String(t.getDate()).padStart(2, '0');
            const h = String(t.getHours()).padStart(2, '0');
            buckets.push(`${y}${M}${d}${h}`);
        }
        return buckets;
    }

    /**
     * 模型名中可能含 `/`，替换为 `_` 以避免 Upstash REST URL 路径问题
     */
    private _sanitizeModelName(model: string): string {
        return model.replace(/\//g, '_');
    }

    /**
     * 通用计数器自增（fire-and-forget）
     */
    private _incr(counterName: string): void {
        if (!this.enabled) return;

        const bucket = this._getHourBucket();
        const key = `${KEY_PREFIX}:${counterName}:${bucket}`;

        this._execPipeline([
            ['INCR', key],
            ['EXPIRE', key, String(TTL_SECONDS)],
        ]).catch(err => {
            logger.warn({
                kind: 'sys', component: COMPONENT,
                message: 'Metric INCR failed (non-fatal)',
                error: err instanceof Error ? err.message : String(err),
                meta: { key },
            });
        });
    }

    /**
     * 模型维度计数器自增 + 注册模型名到 Set（fire-and-forget）
     */
    private _incrModelMetric(model: string, subMetric: string): void {
        if (!this.enabled) return;

        const sanitized = this._sanitizeModelName(model);
        const bucket = this._getHourBucket();
        const key = `${KEY_PREFIX}:model:${sanitized}:${subMetric}:${bucket}`;

        this._execPipeline([
            ['INCR', key],
            ['EXPIRE', key, String(TTL_SECONDS)],
            ['SADD', MODEL_REGISTRY_KEY, sanitized],
        ]).catch(err => {
            logger.warn({
                kind: 'sys', component: COMPONENT,
                message: 'Model metric INCR failed (non-fatal)',
                error: err instanceof Error ? err.message : String(err),
                meta: { key },
            });
        });
    }

    /**
     * 批量 GET：通过 pipeline 接口一次性读取多个 key，返回对应的数值数组
     */
    private async _mget(keys: string[]): Promise<number[]> {
        if (keys.length === 0) return [];

        const commands = keys.map(k => ['GET', k]);
        const url = `${this.baseUrl}/pipeline`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(commands),
        });

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Pipeline GET failed ${resp.status}: ${text}`);
        }

        const data = await resp.json() as { result?: unknown }[];
        return data.map(item => {
            const val = Number(item?.result);
            return isNaN(val) ? 0 : val;
        });
    }

    /**
     * SMEMBERS：获取 Set 中所有成员
     */
    private async _smembers(key: string): Promise<string[]> {
        const encodedKey = encodeURIComponent(key);
        const url = `${this.baseUrl}/smembers/${encodedKey}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) return [];
        const data = await resp.json() as { result?: string[] };
        return data.result ?? [];
    }

    /**
     * 使用 Upstash pipeline 接口批量执行命令
     */
    private async _execPipeline(commands: string[][]): Promise<void> {
        const url = `${this.baseUrl}/pipeline`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(commands),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Pipeline failed ${resp.status}: ${text}`);
        }
    }
}

export const metrics = MetricsCollector.getInstance();