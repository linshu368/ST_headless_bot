/**
 * Layer A: Domain Rules - 模型策略
 * 纯业务规则，不涉及 IO
 */

// 1. 定义产品等级 (Product Tiers) - 业务语言
export enum ModelTier {
    BASIC = 'basic',       // 基础模型
    STANDARD_A = 'standard_a', // 中级模型A
    STANDARD_B = 'standard_b', // 中级模型B
}

// 2. 配置映射表：Tier -> Channel ID
// 这是核心业务决策配置
// [Modified] 现在从 Config Source 动态读取，而不是硬编码
import config from '../../../platform/config.js';

/**
 * 规则：根据产品等级解析通道 ID
 */
export function resolveChannelId(tier: ModelTier): string {
    const mapping = config.ai_config_source.tier_mapping;
    return mapping[tier] || 'channel_3'; // 默认兜底到 Premium/Channel_3
}

/**
 * 规则：将展示名称/工程语义映射到 Tier
 */
export function mapLegacyModeToTier(legacyMode: string): ModelTier {
    // 归一化处理
    const mode = legacyMode?.toLowerCase().trim();
    
    switch (mode) {
        case 'basic':
        case '基础模型':
            return ModelTier.BASIC;
        case 'standard_a':
        case '中级模型a':
            return ModelTier.STANDARD_A;
        case 'standard_b':
        case '中级模型b':
            return ModelTier.STANDARD_B;
        default:
            // 未知模式默认为中级模型B
            return ModelTier.STANDARD_B;
    }
}
