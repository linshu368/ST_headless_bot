/**
 * UserPreferences — 用户偏好类型定义
 *
 * 职责：作为多层共享的单一类型来源（domain 层）
 *
 * 数据流向：
 *   运行时读写 → Redis（UpstashSessionStore）
 *   事实记录  → Supabase bot_users（独立字段）+ messages（JSON 快照）
 *   合法值源  → runtimeConfig.pref_word_count_tiers
 */

// =============================================
// 核心接口
// =============================================

export interface UserPreferences {
    /** 字数档位的 prompt_value，注入到 {{WORD_COUNT}} 占位符 */
    word_count: string;
    /** 是否在每轮末尾生成行动选项 */
    show_options: boolean;
    /** 用户自由文本偏好指令 */
    custom_instructions: string;
}

// =============================================
// 字数档位配置（存储在 runtimeConfig）
// =============================================

/** 单个字数档位 */
export interface WordCountTier {
    /** Telegram 按钮上展示的文案 */
    label: string;
    /** 注入 system_instructions 模板的值 */
    prompt_value: string;
}

/** pref_word_count_tiers 配置项的完整结构 */
export interface WordCountTiersConfig {
    tiers: WordCountTier[];
    /** 新用户默认档位（对应某个 tier 的 prompt_value） */
    default_value: string;
}

// =============================================
// 选项模式指令块（存储在 runtimeConfig）
// =============================================

export interface InteractionModeBlocks {
    /** show_options = true 时注入的完整指令 */
    options_on: string;
    /** show_options = false 时注入的完整指令 */
    options_off: string;
}

// =============================================
// 静态默认值（最终兜底，仅当 runtimeConfig 也不可用时使用）
// =============================================

export const DEFAULT_WORD_COUNT_TIERS_CONFIG: WordCountTiersConfig = {
    tiers: [
        { label: '150以内', prompt_value: '150以内' },
        { label: '150-300', prompt_value: '150-300' },
        { label: '300-500', prompt_value: '300-500' },
        { label: '500-800', prompt_value: '500-800' },
        { label: '800以上', prompt_value: '800以上' },
    ],
    default_value: '300-500',
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
    word_count: DEFAULT_WORD_COUNT_TIERS_CONFIG.default_value,
    show_options: false,
    custom_instructions: '暂无',
};

export const DEFAULT_INTERACTION_MODE_BLOCKS: InteractionModeBlocks = {
    options_on: '正文结束后，另起一行，生成2-3个选项供用户参考。选项应基于当前场景逻辑自然延伸，不得替用户预设立场或情感倾向。用户可以选择其中之一，也可以完全忽略选项自行输入。选项的存在不改变Anti-Godmodding规则——它们是建议，不是限制。\n若用户指令为单个数字（如"1"、"2"）或单个字母（如"a"、"b"），应自动判断为用户选择了对应序号的选项，并将该选项的完整行动方向视为用户的实际输入，以此为基础推进剧情，叙事深度和沉浸感与用户完整输入时完全一致，不得因用户输入简短而缩减回复质量。',
    options_off: '不要在回复末尾生成任何选项。用户自行决定下一步行动。',
};

// =============================================
// 约束常量
// =============================================

/** 自定义指令最大长度（字符数） */
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 500;

// =============================================
// 工具函数
// =============================================

/**
 * 校验 word_count 值是否在当前配置的合法档位中
 * @param value 待校验的值
 * @param tiersConfig 从 runtimeConfig 获取的档位配置
 * @returns 合法则返回原值，否则返回默认值
 */
export function resolveWordCount(value: string | undefined | null, tiersConfig: WordCountTiersConfig): string {
    if (!value) return tiersConfig.default_value;
    const valid = tiersConfig.tiers.some(t => t.prompt_value === value);
    return valid ? value : tiersConfig.default_value;
}