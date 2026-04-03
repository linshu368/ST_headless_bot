import type { AIChannelConfig, TierMappingConfig } from '../../types/config.js';
import type { CreditsPlan } from '../../types/payment.js';
import type { AIConfigSourceData } from './RuntimeConfigService.js';

export interface RuntimeConfigMeta {
    version: number | null;
    updated_at: string | null;
}

export interface RuntimeConfigRowInput {
    key: string;
    value: unknown;
    text_value?: string | null;
    version?: number | string | null;
    updated_at?: string | null;
}

export interface RuntimeConfigRowParsed<T> {
    key: string;
    value: T;
    version: number | null;
    updated_at: string | null;
}

const NUMBER_STRING_REGEX = /^-?\d+(?:\.\d+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseVersion = (value: RuntimeConfigRowInput['version']): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && NUMBER_STRING_REGEX.test(value)) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const parseUpdatedAt = (value: RuntimeConfigRowInput['updated_at']): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

const requireTextValue = (key: string, textValue: string | null | undefined): string => {
    if (typeof textValue === 'string' && textValue.length > 0) {
        return textValue;
    }
    // 允许空字符串吗？根据业务，有些配置可能不能为空。
    // 如果必须非空：
    throw new Error(`RuntimeConfigSchema: ${key} must be a non-empty string in 'text_value' column`);
};

const requireString = (field: string, value: unknown, key: string): string => {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    throw new Error(`RuntimeConfigSchema: ${key}.${field} must be a string in 'value' column`);
};

const parseNumber = (field: string, value: unknown, key: string): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && NUMBER_STRING_REGEX.test(value)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`RuntimeConfigSchema: ${key}.${field} must be number`);
};

const parseAIConfigSource = (value: unknown, key: string): AIConfigSourceData => {
    if (!isRecord(value)) {
        throw new Error(`RuntimeConfigSchema: ${key} must be an object`);
    }
    const channelsRaw = value.channels;
    const tierRaw = value.tier_mapping;

    if (!isRecord(channelsRaw)) {
        throw new Error(`RuntimeConfigSchema: ${key}.channels must be an object`);
    }
    if (!isRecord(tierRaw)) {
        throw new Error(`RuntimeConfigSchema: ${key}.tier_mapping must be an object`);
    }

    const channels: AIChannelConfig = {};
    for (const [channelId, stepsRaw] of Object.entries(channelsRaw)) {
        if (!Array.isArray(stepsRaw)) {
            throw new Error(`RuntimeConfigSchema: ${key}.channels.${channelId} must be array`);
        }
        channels[channelId] = stepsRaw.map((stepRaw, idx) => {
            if (!isRecord(stepRaw)) {
                throw new Error(`RuntimeConfigSchema: ${key}.channels.${channelId}[${idx}] must be object`);
            }
            const id = requireString('id', stepRaw.id, key);
            const provider = requireString('provider', stepRaw.provider, key);
            const url = requireString('url', stepRaw.url, key);
            const apiKey = requireString('key', stepRaw.key, key);
            const model = requireString('model', stepRaw.model, key);
            const firstchunk_timeout = stepRaw.firstchunk_timeout !== undefined
                ? parseNumber('firstchunk_timeout', stepRaw.firstchunk_timeout, key)
                : undefined;
            const total_timeout = parseNumber('total_timeout', stepRaw.total_timeout, key);

            return {
                id,
                provider,
                url,
                key: apiKey,
                model,
                firstchunk_timeout,
                total_timeout,
            };
        });
    }

    const tier_mapping: TierMappingConfig = {};
    for (const [tier, channelId] of Object.entries(tierRaw)) {
        tier_mapping[tier] = requireString(`tier_mapping.${tier}`, channelId, key);
    }

    // tier_costs: optional Record<string, number>, fallback handled by caller
    let tier_costs: Record<string, number> | undefined;
    const costsRaw = value.tier_costs;
    if (costsRaw !== undefined && costsRaw !== null) {
        if (!isRecord(costsRaw)) {
            throw new Error(`RuntimeConfigSchema: ${key}.tier_costs must be an object`);
        }
        tier_costs = {};
        for (const [tier, cost] of Object.entries(costsRaw)) {
            tier_costs[tier] = parseNumber(`tier_costs.${tier}`, cost, key);
        }
        // Cross-validation: every tier in tier_mapping must have a cost entry
        for (const tier of Object.keys(tier_mapping)) {
            if (!(tier in tier_costs)) {
                throw new Error(`RuntimeConfigSchema: ${key}.tier_costs missing entry for "${tier}"`);
            }
        }
    }

    return { channels, tier_mapping, tier_costs };
};

const parseCreditsPlans = (value: unknown, key: string): CreditsPlan[] => {
    if (!Array.isArray(value)) {
        throw new Error(`RuntimeConfigSchema: ${key} must be an array`);
    }
    return value.map((planRaw, idx) => {
        if (!isRecord(planRaw)) {
            throw new Error(`RuntimeConfigSchema: ${key}[${idx}] must be an object`);
        }
        const credits = parseNumber('credits', planRaw.credits, key);
        const priceCNY = parseNumber('priceCNY', planRaw.priceCNY, key);
        return { credits, priceCNY };
    });
};

export const RuntimeConfigSchema = {
    parse<T = unknown>(input: RuntimeConfigRowInput): RuntimeConfigRowParsed<T> {
        const version = parseVersion(input.version);
        const updated_at = parseUpdatedAt(input.updated_at);

        switch (input.key) {
            case 'ai_config_source': {
                // 复杂对象仍然只从 value 解析
                const value = parseAIConfigSource(input.value, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'payment_credits_plans': {
                const value = parseCreditsPlans(input.value, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'max_history_items':
            case 'history_retention_count':
            case 'session_timeout_minutes':
            case 'streaming_first_update_chars':
            case 'streaming_regular_update_interval_sec':
            case 'checkin_reward': {
                const value = parseNumber(input.key, input.value, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'default_role_id': {
                const raw = input.value;
                const value = typeof raw === 'number' ? String(raw) : requireString(input.key, raw, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'system_instructions':
            case 'welcome_message':
            case 'insufficient_credits_message':
            case 'customer_service_message':
            case 'ops_prompt_commit_process_diff':
            case 'ops_prompt_project_arch':
            case 'ops_prompt_project_principle':
            case 'payment_recharge_welcome':
            case 'payment_order_created':
            case 'payment_order_expired':
            case 'payment_order_pending':
            case 'payment_order_failed':
            case 'payment_success': {
                // 纯文本配置（含模板占位符）：只读 text_value
                const value = requireTextValue(input.key, input.text_value);
                return { key: input.key, value: value as T, version, updated_at };
            }
            default: {
                if (input.value === null || input.value === undefined) {
                    throw new Error(`RuntimeConfigSchema: ${input.key} value is null/undefined`);
                }
                return { key: input.key, value: input.value as T, version, updated_at };
            }
        }
    },
};
