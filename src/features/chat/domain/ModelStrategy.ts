/**
 * Layer A: Domain Rules - 模型策略
 * 纯业务规则，不涉及 IO
 */

// 1. 定义产品等级 (Product Tiers) - 业务语言
export enum ModelTier {
    TIER_1 = 'tier_1', // 快餐模型
    TIER_2 = 'tier_2', // 基础模型
    TIER_3 = 'tier_3', // 旗舰模型
    TIER_4 = 'tier_4', // 尊享模型
}

// 2. 配置映射表：Tier -> Channel ID
// [Modified] 从 RuntimeConfigService 动态读取
import { runtimeConfig } from '../../../infrastructure/runtime_config/RuntimeConfigService.js';

/**
 * 规则：根据产品等级解析通道 ID
 * 现在从 Supabase → Redis → 静态配置 三层获取映射关系
 */
export async function resolveChannelId(tier: ModelTier): Promise<string> {
    const configSource = await runtimeConfig.getAIConfigSource();
    return configSource.tier_mapping[tier] || 'channel_3'; // 默认兜底到 Channel_3
}

/**
 * 规则：将用户模式值解析为 Tier
 */
export function resolveTierFromMode(mode: string): ModelTier {
    const normalized = mode?.toLowerCase().trim();
    if (normalized === ModelTier.TIER_1) return ModelTier.TIER_1;
    if (normalized === ModelTier.TIER_2) return ModelTier.TIER_2;
    if (normalized === ModelTier.TIER_3) return ModelTier.TIER_3;
    if (normalized === ModelTier.TIER_4) return ModelTier.TIER_4;
    return ModelTier.TIER_3; // 未知模式默认为旗舰模型
}
