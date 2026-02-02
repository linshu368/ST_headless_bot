/**
 * Layer A: Domain Rules - 模型策略
 * 纯业务规则，不涉及 IO
 */

// 1. 定义产品等级 (Product Tiers) - 业务语言
export enum ModelTier {
    BASIC = 'basic',       // 基础版
    STANDARD = 'standard', // 进阶版 (原 Story)
    PREMIUM = 'premium',   // 旗舰版 (原 Immersive)
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
 * 规则：兼容旧系统的 mode 字符串映射到新的 Tier
 */
export function mapLegacyModeToTier(legacyMode: string): ModelTier {
    // 归一化处理
    const mode = legacyMode?.toLowerCase().trim();
    
    switch (mode) {
        case 'fast':
            return ModelTier.BASIC;
        case 'story':
            return ModelTier.STANDARD;
        case 'immersive':
            return ModelTier.PREMIUM;
        default:
            // 未知模式默认为旗舰版
            return ModelTier.PREMIUM;
    }
}
