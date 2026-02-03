export interface AIProfileConfig {
    id: string;          // 步骤ID，用于日志追踪 (e.g., "step_1_grok")
    provider: string;    // 厂商标识 (e.g., "openai", "anthropic")
    url: string;         // 完整 API Endpoint
    key: string;         // API Key
    model: string;       // 模型名称
    timeout?: number;    // 超时设置 (ms)
}

export type AIChannelConfig = Record<string, AIProfileConfig[]>;

export type TierMappingConfig = Record<string, string>;
