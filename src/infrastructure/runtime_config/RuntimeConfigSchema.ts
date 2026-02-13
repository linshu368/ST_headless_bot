import type { AIChannelConfig, TierMappingConfig } from '../../types/config.js';
import type { AIConfigSourceData } from './RuntimeConfigService.js';

export interface RuntimeConfigMeta {
    version: number | null;
    updated_at: string | null;
}

export interface RuntimeConfigRowInput {
    key: string;
    value: unknown;
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

const requireString = (field: string, value: unknown, key: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`RuntimeConfigSchema: ${key}.${field} must be non-empty string`);
    }
    return value;
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
            const total_timeout = stepRaw.total_timeout !== undefined
                ? parseNumber('total_timeout', stepRaw.total_timeout, key)
                : undefined;

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

    return { channels, tier_mapping };
};

export const RuntimeConfigSchema = {
    parse<T = unknown>(input: RuntimeConfigRowInput): RuntimeConfigRowParsed<T> {
        const version = parseVersion(input.version);
        const updated_at = parseUpdatedAt(input.updated_at);

        switch (input.key) {
            case 'ai_config_source': {
                const value = parseAIConfigSource(input.value, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'max_history_items':
            case 'history_retention_count':
            case 'session_timeout_minutes':
            case 'ai_stream_inter_chunk_timeout':
            case 'ai_stream_total_timeout': {
                const value = parseNumber(input.key, input.value, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'default_role_id': {
                const raw = input.value;
                const value = typeof raw === 'number' ? String(raw) : requireString(input.key, raw, input.key);
                return { key: input.key, value: value as T, version, updated_at };
            }
            case 'system_instructions':
            case 'welcome_message': {
                const value = requireString(input.key, input.value, input.key);
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
