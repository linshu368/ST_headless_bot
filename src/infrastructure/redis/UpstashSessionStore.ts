import { logger } from '../../platform/logger.js';
import type { SessionMessage, SessionStore } from '../../core/ports/SessionStore.js';

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
    private readonly maxHistoryItems: number;
    private readonly historyRetentionCount: number;
    private readonly debugEnabled: boolean;

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

    private encode(value: string): string {
        return encodeURIComponent(value);
    }

    private async cmd(...args: string[]): Promise<UpstashResponse> {
        if (args.length === 0) {
            throw new Error('Upstash cmd requires at least one argument');
        }
        const command = args[0].toLowerCase();
        let url = '';
        let response: Response;

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
        return data;
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

    async getUserModelMode(userId: string): Promise<'basic' | 'standard_a' | 'standard_b'> {
        const key = this.keyUserModelMode(userId);
        try {
            const result = await this.cmd('get', key);
            const value = this.decodeGetResult(result);
            if (value === 'basic' || value === 'standard_a' || value === 'standard_b') {
                return value;
            }
            if (value && typeof value === 'object') {
                const obj = value as Record<string, unknown>;
                const inner = obj.value ?? obj.result;
                if (inner === 'basic' || inner === 'standard_a' || inner === 'standard_b') {
                    return inner;
                }
            }
            return 'standard_b';
        } catch {
            return 'standard_b';
        }
    }

    async setUserModelMode(
        userId: string,
        mode: 'basic' | 'standard_a' | 'standard_b'
    ): Promise<void> {
        const key = this.keyUserModelMode(userId);
        await this.cmd('set', key, mode);
    }
}
