/**
 * 模板渲染：system_instructions 占位符替换
 *
 * 纯函数，无副作用，无外部依赖。
 * 放在 rules 层，方便单元测试。
 */

import type { UserPreferences, WordCountTiersConfig } from '../domain/UserPreferences.js';

// ─── 辅助函数 ───────────────────────────────────────────────

/**
 * 从字数档位配置中解析用户选择对应的 prompt_value。
 *
 * 查找逻辑：
 *   1. 在 tiers 数组中匹配 label === userWordCount，返回其 prompt_value
 *   2. 匹配失败 → 回退到 default_tier 对应的 prompt_value
 *   3. default_tier 也匹配失败 → 原样返回 userWordCount（最终兜底，避免模板出现空白）
 *
 * 导出供单元测试直接验证。
 */
export function resolveWordCountPromptValue(
    userWordCount: string,
    tiersConfig: WordCountTiersConfig,
): string {
    const match = tiersConfig.tiers.find(t => t.label === userWordCount);
    if (match) return match.prompt_value;

    const fallback = tiersConfig.tiers.find(t => t.prompt_value === tiersConfig.default_value);
    return fallback?.prompt_value ?? userWordCount;
}

// ─── 主渲染函数 ─────────────────────────────────────────────

/**
 * 将 system_instructions 模板渲染为最终指令字符串。
 *
 * 占位符替换规则（全局替换，支持模板中同一占位符出现多次）：
 *   {{WORD_COUNT}}                → 用户字数档位对应的 prompt_value
 *   {{INTERACTION_MODE}}          → 已选中的选项模式指令块（options_on 或 options_off）
 *   {{USER_CUSTOM_INSTRUCTIONS}}  → 用户自定义指令文本（为空时注入 "暂无"）
 *
 * @param template              含占位符的 system_instructions 模板（来自 runtimeConfig）
 * @param preferences           用户偏好（来自 Redis）
 * @param interactionModeBlock  根据 preferences.show_options 已选中的指令块文本
 * @param tiersConfig           字数档位配置（来自 runtimeConfig，用于 label → prompt_value 映射）
 * @returns 渲染后的完整系统指令
 */
export function renderSystemInstructions(
    template: string,
    preferences: UserPreferences,
    interactionModeBlock: string,
    tiersConfig: WordCountTiersConfig,
): string {
    const wordCountValue = resolveWordCountPromptValue(
        preferences.word_count,
        tiersConfig,
    );

    const customInstructions = preferences.custom_instructions?.trim() || '暂无';

    return template
        .replace(/\{\{WORD_COUNT\}\}/g, wordCountValue)
        .replace(/\{\{INTERACTION_MODE\}\}/g, interactionModeBlock)
        .replace(/\{\{USER_CUSTOM_INSTRUCTIONS\}\}/g, customInstructions);
}