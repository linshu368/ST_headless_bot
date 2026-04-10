import { logger } from '../../platform/logger.js';
import type { SessionMessage, SessionStore } from '../../core/ports/SessionStore.js';
import { feishuAlert, AlertType } from '../alerts/FeishuAlertService.js';
import { isTransientNetworkError } from '../utils/networkErrors.js';
import type { UserPreferences } from '../../features/chat/domain/UserPreferences.js';
import { DEFAULT_USER_PREFERENCES } from '../../features/chat/domain/UserPreferences.js';


type UpstashResponse = {
    result?: unknown;
    value?: unknown;
    error?: string;
};

const COMPONENT = 'UpstashSessionStore';

export class UpstashSessionStore implements SessionStore {
    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly namespace: string;
    private maxHistoryItems: number;
    private historyRetentionCount: number;
    private readonly debugEnabled: boolean;

    // --- Redis 连接健康度跟踪 ---
    private consecutiveFailures = 0;
    private transientFailureCount = 0;
    private connectionLostAlerted = false;
    private degradedAlerted = false;
    private probeInFlight = false;

    /** 非瞬态错误连续失败阈值（保持原有灵敏度） */
    private readonly FAILURE_THRESHOLD = 5;
    /** 瞬态网络错误连续失败阈值（降噪） */
    private readonly TRANSIENT_FAILURE_THRESHOLD = 10;
    /** 主动探活超时 */
    private readonly PROBE_TIMEOUT_MS = 5_000;

    constructor(params: {
        restUrl: string;
        token: string;
        namespace?: string;
        maxHistoryItems?: number;
        historyRetentionCount?: number;
        debug?: boolean;
    }) {
        const { restUrl, token } = params;
        if (!restUrl || !token) {
            throw new Error('UpstashSessionStore requires non-empty restUrl and token');
        }
        this.baseUrl = restUrl.replace(/\/+$/, '');
        this.headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        this.namespace = params.namespace || 'session';
        this.maxHistoryItems = Math.max(1, params.maxHistoryItems ?? 150);
        this.historyRetentionCount = Math.max(
            1,
            params.historyRetentionCount ?? this.maxHistoryItems
        );
        this.debugEnabled = Boolean(params.debug);
        logger.info({
            kind: 'biz',
            component: COMPONENT,
            message: 'UpstashSessionStore initialized',
            meta: { baseUrl: this.baseUrl, namespace: this.namespace },
        });
    }

    /**
     * 动态更新历史消息上限（由 RuntimeConfigService 驱动）
     */
    setMaxHistoryItems(max: number): void {
        this.maxHistoryItems = Math.max(1, max);
        if (this.historyRetentionCount > this.maxHistoryItems) {
            this.historyRetentionCount = this.maxHistoryItems;
        }
    }

    /**
     * 动态更新历史截断低水位线（由 RuntimeConfigService 驱动）
     */
    setHistoryRetentionCount(count: number): void {
        this.historyRetentionCount = Math.max(1, count);
        if (this.historyRetentionCount > this.maxHistoryItems) {
            this.historyRetentionCount = this.maxHistoryItems;
        }
    }

    private logDebug(message: string, meta?: Record<string, unknown>): void {
        if (!this.debugEnabled) return;
        logger.info({
            kind: 'biz',
            component: COMPONENT,
            message,
            meta,
        });
    }

    private keyMessages(sessionId: string): string {
        return `${this.namespace}:${sessionId}:messages`;
    }

    private keyCurrentSession(userId: string): string {
        return `${this.namespace}:current:${userId}`;
    }

    private keyLastSession(userId: string): string {
        return `${this.namespace}:last:${userId}`;
    }

    private keySessionData(sessionId: string): string {
        return `${this.namespace}:data:${sessionId}`;
    }

    private keyUserModelMode(userId: string): string {
        return `${this.namespace}:user_pref:${userId}:model_mode`;
    }

    private keyLastActive(userId: string): string {
        return `${this.namespace}:user_active:${userId}`;
    }

    private keyUserPreferences(userId: string): string {
        return `${this.namespace}:user_pref:${userId}:preferences`;
    }

    private encode(value: string): string {
        return encodeURIComponent(value);
    }

    // =============================================
    // Redis 连接健康度 — 两级升级 + 探活
    // =============================================

    /**
     * 每次 cmd() 失败后调用（fire-and-forget 触发异步探活）。
     */
    private checkConnectionHealth(error: unknown, command: string): void {
        const allTransient = this.transientFailureCount === this.consecutiveFailures;
        const threshold = allTransient ? this.TRANSIENT_FAILURE_THRESHOLD : this.FAILURE_THRESHOLD;

        // —— 第一级：在原 P0 阈值处，若全是瞬态错误，降级为 P1 观察 ——
        if (allTransient
            && this.consecutiveFailures === this.FAILURE_THRESHOLD
            && !this.degradedAlerted) {
            this.degradedAlerted = true;
            feishuAlert.sendP1({
                alertType: AlertType.REDIS_DEGRADED,
                message: `Redis 连续 ${this.consecutiveFailures} 次请求失败（全部为瞬态网络错误），持续观察中。如持续到 ${this.TRANSIENT_FAILURE_THRESHOLD} 次将升级为 P0。`,
                error,
                meta: {
                    consecutiveFailures: this.consecutiveFailures,
                    transientCount: this.transientFailureCount,
                    lastCommand: command,
                },
            });
        }

        // —— 第二级：达到阈值，准备发 P0（瞬态错误先探活确认） ——
        if (this.consecutiveFailures >= threshold && !this.connectionLostAlerted && !this.probeInFlight) {
            this.probeInFlight = true;
            this.triggerConnectionLostAlert(allTransient, error, command)
                .catch(e => {
                    logger.error({ kind: 'sys', component: COMPONENT, message: 'Error in triggerConnectionLostAlert', error: e });
                })
                .finally(() => {
                    this.probeInFlight = false;
                });
        }
    }

    /**
     * 达到告警阈值时调用。
     * 如果全是瞬态网络错误，先主动探活；探活成功则判定为抖动，不发 P0。
     */
    private async triggerConnectionLostAlert(allTransient: boolean, error: unknown, command: string): Promise<void> {
        if (this.connectionLostAlerted) return;

        if (allTransient) {
            const probeOk = await this.probeRedis();

            // 探活期间可能已经恢复（某次 cmd 成功重置了计数器）
            if (this.consecutiveFailures === 0) return;

            if (probeOk) {
                logger.warn({
                    kind: 'sys',
                    component: COMPONENT,
                    message: `Redis 连续 ${this.consecutiveFailures} 次请求失败（瞬态网络错误），但主动探活成功，判定为网络抖动，不发送 P0`,
                });
                this.resetFailureCounters();
                return;
            }
        }

        // 探活也失败，或包含非瞬态错误 → 确认连接断开，发 P0
        this.connectionLostAlerted = true;
        feishuAlert.sendP0({
            alertType: AlertType.REDIS_CONNECTION_LOST,
            message: `Redis (Upstash) 连续 ${this.consecutiveFailures} 次请求失败，${allTransient ? '主动探活也失败，' : '包含非瞬态错误，'}判定连接断开`,
            error,
            meta: {
                consecutiveFailures: this.consecutiveFailures,
                transientCount: this.transientFailureCount,
                allTransient,
                lastCommand: command,
            },
        });
    }

    /**
     * 主动探活：向 Upstash 发一个 PING，验证是否真正不可达。
     */
    private async probeRedis(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), this.PROBE_TIMEOUT_MS);
            fetch(`${this.baseUrl}/ping`, { headers: this.headers })
                .then((response) => {
                    clearTimeout(timer);
                    resolve(response.ok);
                })
                .catch(() => {
                    clearTimeout(timer);
                    resolve(false);
                });
        });
    }

    /**
     * 重置连接健康度计数器（探活成功 / 恢复正常时调用）。
     */
    private resetFailureCounters(): void {
        this.consecutiveFailures = 0;
        this.transientFailureCount = 0;
        this.degradedAlerted = false;
        // 注意：connectionLostAlerted 仅在 cmd() 真正成功时才重置
    }

    private async cmd(...args: string[]): Promise<UpstashResponse> {
        if (args.length === 0) {
            throw new Error('Upstash cmd requires at least one argument');
        }
        const command = args[0].toLowerCase();
        let url = '';
        let response: Response;

        try {
            if (command === 'get') {
                if (args.length < 2) {
                    throw new Error('GET requires key');
                }
                const key = this.encode(String(args[1]));
                url = `${this.baseUrl}/get/${key}`;
                response = await fetch(url, { headers: this.headers });
            } else if (command === 'set') {
                if (args.length < 3) {
                    throw new Error('SET requires key and value');
                }
                const key = this.encode(String(args[1]));
                url = `${this.baseUrl}/set/${key}`;
                response = await fetch(url, {
                    method: 'POST',
                    headers: this.headers,
                    body: JSON.stringify({ value: args[2] }),
                });
            } else {
                const encodedArgs = args.slice(1).map((value) => this.encode(String(value)));
                url = `${this.baseUrl}/${command}`;
                if (encodedArgs.length > 0) {
                    url = `${url}/${encodedArgs.join('/')}`;
                }
                response = await fetch(url, { method: 'POST', headers: this.headers });
            }

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Upstash error ${response.status}: ${text}`);
            }

            const data = (await response.json()) as UpstashResponse;
            if (data && typeof data === 'object' && data.error) {
                throw new Error(String(data.error));
            }

            // ---- 请求成功，重置健康度计数 ----
            if (this.consecutiveFailures > 0) {
                this.resetFailureCounters();
            }
            if (this.connectionLostAlerted) {
                this.connectionLostAlerted = false;
                logger.info({ kind: 'sys', component: COMPONENT, message: 'Redis connection recovered (P0 cleared)' });
            }
            return data;
        } catch (error) {
            this.consecutiveFailures++;
            if (isTransientNetworkError(error)) {
                this.transientFailureCount++;
            }
            this.checkConnectionHealth(error, command);
            throw error;
        }
    }

    private unwrapResult(value: unknown): unknown {
        let raw = value;
        while (
            raw &&
            typeof raw === 'object' &&
            !Array.isArray(raw) &&
            (('result' in raw) || ('value' in raw))
        ) {
            const obj = raw as Record<string, unknown>;
            raw = obj.result ?? obj.value;
        }
        return raw;
    }

    private decodeGetResult(result: UpstashResponse | unknown): unknown {
        let raw: unknown = null;
        if (result && typeof result === 'object') {
            const res = result as UpstashResponse;
            raw = this.unwrapResult(res.result ?? res.value);
        }

        if (raw === null || raw === undefined || raw === '' || raw === 'null') {
            return null;
        }
        if (typeof raw === 'string') {
            const tryParse = (value: string): unknown => {
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            };
            let parsed = tryParse(raw);
            if (typeof parsed === 'string') {
                parsed = tryParse(parsed);
            }
            return this.unwrapResult(parsed);
        }
        return this.unwrapResult(raw);
    }

    async getMessages(sessionId: string): Promise<SessionMessage[]> {
        const key = this.keyMessages(sessionId);
        try {
            const result = await this.cmd('lrange', key, '0', '-1');
            const rawList = result.result ?? result.value;
            if (!rawList || !Array.isArray(rawList)) {
                return [];
            }
            const messages: SessionMessage[] = [];
            for (const item of rawList) {
                if (typeof item === 'string') {
                    try {
                        const parsed = JSON.parse(item);
                        if (parsed && typeof parsed === 'object') {
                            messages.push(parsed as SessionMessage);
                        }
                    } catch {
                        continue;
                    }
                } else if (item && typeof item === 'object') {
                    messages.push(item as SessionMessage);
                }
            }
            return messages;
        } catch {
            try {
                const result = await this.cmd('get', key);
                const raw = result.result ?? result.value;
                if (raw === null || raw === undefined || raw === '' || raw === 'null') {
                    return [];
                }
                if (Array.isArray(raw)) {
                    return raw as SessionMessage[];
                }
                if (typeof raw === 'string') {
                    try {
                        const parsed = JSON.parse(raw);
                        return Array.isArray(parsed) ? (parsed as SessionMessage[]) : [];
                    } catch {
                        return [];
                    }
                }
                return [];
            } catch {
                return [];
            }
        }
    }

    async setMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
        const key = this.keyMessages(sessionId);
        try {
            await this.cmd('del', key);
        } catch {
            // ignore
        }

        if (messages.length === 0) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'Session history updated',
                meta: { sessionId, count: 0 },
            });
            return;
        }

        const values = messages.map((message) => JSON.stringify(message));
        await this.cmd('rpush', key, ...values);

        if (messages.length > this.maxHistoryItems) {
            try {
                await this.cmd(
                    'ltrim',
                    key,
                    String(-this.historyRetentionCount),
                    '-1'
                );
            } catch (error) {
                logger.warn({
                    kind: 'biz',
                    component: COMPONENT,
                    message: 'setMessages ltrim failed',
                    error,
                });
            }
        }

        logger.info({
            kind: 'biz',
            component: COMPONENT,
            message: 'Session history updated',
            meta: { sessionId, count: messages.length },
        });
    }

    async appendMessage(sessionId: string, message: SessionMessage): Promise<void> {
        const key = this.keyMessages(sessionId);
        try {
            const response = await this.cmd('rpush', key, JSON.stringify(message));
            const currentLen = Number(response.result ?? response.value ?? 0);
            if (currentLen > this.maxHistoryItems) {
                await this.cmd(
                    'ltrim',
                    key,
                    String(-this.historyRetentionCount),
                    '-1'
                );
            }
        } catch {
            const existing = await this.getMessages(sessionId);
            existing.push(message);
            await this.setMessages(sessionId, existing);
        }
    }

    async getCurrentSessionId(userId: string): Promise<string | null> {
        const key = this.keyCurrentSession(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            if (value && typeof value === 'object') {
                const obj = value as Record<string, unknown>;
                const sid = obj.session_id ?? obj.value;
                return typeof sid === 'string' && sid.length > 0 ? sid : null;
            }
            return typeof value === 'string' && value.length > 0 ? value : null;
        } catch {
            return null;
        }
    }

    async setCurrentSessionId(userId: string, sessionId: string): Promise<void> {
        const key = this.keyCurrentSession(userId);
        await this.cmd('set', key, sessionId);
    }

    async getLastSessionId(userId: string): Promise<string | null> {
        const key = this.keyLastSession(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            if (value && typeof value === 'object') {
                const obj = value as Record<string, unknown>;
                const sid = obj.session_id ?? obj.value;
                return typeof sid === 'string' && sid.length > 0 ? sid : null;
            }
            return typeof value === 'string' && value.length > 0 ? value : null;
        } catch {
            return null;
        }
    }

    async setLastSessionId(userId: string, sessionId: string): Promise<void> {
        const key = this.keyLastSession(userId);
        await this.cmd('set', key, sessionId);
    }

    async getSessionData(sessionId: string): Promise<Record<string, unknown> | null> {
        const key = this.keySessionData(sessionId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            this.logDebug('getSessionData raw', { result, value });
            return value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }

    async setSessionData(sessionId: string, data: Record<string, unknown>): Promise<void> {
        const key = this.keySessionData(sessionId);
        await this.cmd('set', key, data as unknown as string);
    }

    async getUserModelMode(userId: string): Promise<'tier_1' | 'tier_2' | 'tier_3' | 'tier_4'> {
        const key = this.keyUserModelMode(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            if (value === 'tier_1' || value === 'tier_2' || value === 'tier_3' || value === 'tier_4') {
                return value;
            }
            if (value && typeof value === 'object') {
                const obj = value as Record<string, unknown>;
                const inner = obj.value ?? obj.result;
                if (inner === 'tier_1' || inner === 'tier_2' || inner === 'tier_3' || inner === 'tier_4') {
                    return inner;
                }
            }
            return 'tier_3';
        } catch {
            return 'tier_3';
        }
    }

    async setUserModelMode(
        userId: string,
        mode: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4'
    ): Promise<void> {
        const key = this.keyUserModelMode(userId);
        await this.cmd('set', key, mode);
    }

    async getLastActiveTime(userId: string): Promise<number | null> {
        const key = this.keyLastActive(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const num = Number(value);
                return isNaN(num) ? null : num;
            }
            return null;
        } catch {
            return null;
        }
    }

    async setLastActiveTime(userId: string, timestamp: number): Promise<void> {
        const key = this.keyLastActive(userId);
        await this.cmd('set', key, String(timestamp));
    }


    // =============================================
    // User Preferences
    // =============================================
    /**
     * 获取用户偏好
     * 
     * 校验策略：只做结构级校验（字段存在性、类型），不做业务级校验
     * （如 word_count 是否在当前合法档位中）。业务校验由上层在拿到
     * runtimeConfig.getWordCountTiers() 后通过 resolveWordCount() 执行。
     */
    async getUserPreferences(userId: string): Promise<UserPreferences> {
        const key = this.keyUserPreferences(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const obj = value as Record<string, unknown>;
                return {
                    word_count: typeof obj.word_count === 'string' && obj.word_count.length > 0
                        ? obj.word_count
                        : DEFAULT_USER_PREFERENCES.word_count,
                    show_options: typeof obj.show_options === 'boolean'
                        ? obj.show_options
                        : DEFAULT_USER_PREFERENCES.show_options,
                    custom_instructions: typeof obj.custom_instructions === 'string'
                        ? obj.custom_instructions
                        : DEFAULT_USER_PREFERENCES.custom_instructions,
                };
            }

            return { ...DEFAULT_USER_PREFERENCES };
        } catch {
            return { ...DEFAULT_USER_PREFERENCES };
        }
    }

    /**
     * 整体覆写用户偏好
     */
    async setUserPreferences(userId: string, prefs: UserPreferences): Promise<void> {
        const key = this.keyUserPreferences(userId);
        await this.cmd('set', key, JSON.stringify(prefs));
    }

    /**
     * 单字段更新用户偏好（Telegram UI 场景：用户只改了字数或只改了选项开关）
     * 读 → 改 → 写，返回更新后的完整偏好对象
     */
    async updateUserPreference(
        userId: string,
        field: keyof UserPreferences,
        value: string | boolean,
    ): Promise<UserPreferences> {
        const current = await this.getUserPreferences(userId);

        switch (field) {
            case 'word_count':
                if (typeof value === 'string') {
                    current.word_count = value;
                }
                break;
            case 'show_options':
                if (typeof value === 'boolean') {
                    current.show_options = value;
                }
                break;
            case 'custom_instructions':
                if (typeof value === 'string') {
                    current.custom_instructions = value;
                }
                break;
        }

        await this.setUserPreferences(userId, current);
        return current;
    }
}