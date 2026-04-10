import TelegramBot from 'node-telegram-bot-api';
import { ModelTier } from '../chat/domain/ModelStrategy.js';
import type { WordCountTiersConfig } from '../chat/domain/UserPreferences.js';

export class UIHandler {
    static createMainMenuKeyboard(): TelegramBot.ReplyKeyboardMarkup {
        return {
            keyboard: [
                [{ text: "🎭 选择角色" }, { text: "💰 充值" }],
                [{ text: "🗂 历史聊天" },{ text: "👤 个人中心" }],
                [{ text: "📅 每日签到" }, { text: "⚙️ 偏好设置" }],
                [{ text: "☎️ 客服&售后" }]
            ],
            resize_keyboard: true
        };
    }

    static createSettingsKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "关闭个人中心", callback_data: "close_settings" }]
            ]
        };
    }

    // =============================================
    // 偏好设置键盘
    // =============================================

    static createPreferencesKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "🤖 文本模型选择", callback_data: "pref_model_select" }],
                [{ text: "📝 字数设置", callback_data: "pref_word_count" }],
                [{ text: "🎯 选项设置", callback_data: "pref_options" }],
                [{ text: "✏️ 自定义指令", callback_data: "pref_custom_instructions" }],
            ]
        };
    }

    static createWordCountKeyboard(
        currentValue: string,
        tiersConfig: WordCountTiersConfig,
    ): TelegramBot.InlineKeyboardMarkup {
        const buttons = tiersConfig.tiers.map(tier => {
            const isActive = tier.prompt_value === currentValue;
            return [{
                text: `${tier.label}${isActive ? ' ✅' : ''}`,
                callback_data: `pref_set_word_count:${tier.prompt_value}`,
            }];
        });
        buttons.push([{ text: "🔙 返回偏好设置", callback_data: "pref_back" }]);
        return { inline_keyboard: buttons };
    }

    static createShowOptionsKeyboard(currentValue: boolean): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: `加选项${currentValue ? ' ✅' : ''}`, callback_data: "pref_set_options:true" }],
                [{ text: `不要选项${!currentValue ? ' ✅' : ''}`, callback_data: "pref_set_options:false" }],
                [{ text: "🔙 返回偏好设置", callback_data: "pref_back" }],
            ]
        };
    }

    static createCustomInstructionsKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [
                    { text: "➕ 添加指令", callback_data: "pref_ci_append" },
                    { text: "✏️ 编辑指令", callback_data: "pref_ci_replace" },
                ],
                [{ text: "🔙 返回偏好设置", callback_data: "pref_back" }],
            ]
        };
    }

    static createCustomInstructionsInputKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "🔙 返回上一步", callback_data: "pref_ci_back" }],
            ]
        };
    }

    static createRechargeKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "💳 充值星尘", callback_data: "pay_recharge" }]
            ]
        };
    }

    static getModelSelectionCaption(): string {
        return `
━━━━━━━━━━━━
`;
    }

    static createModelSelectionKeyboard(currentMode: string, source: 'settings' | 'pref' = 'settings'): TelegramBot.InlineKeyboardMarkup {
        const isTier1 = currentMode === ModelTier.TIER_1;
        const isTier2 = currentMode === ModelTier.TIER_2;
        const isTier3 = currentMode === ModelTier.TIER_3;
        const isTier4 = currentMode === ModelTier.TIER_4;

        const prefix = source === 'pref' ? 'pref_' : '';
        const backCallback = source === 'pref' ? 'pref_back_from_model' : 'settings_back_from_model';

        return {
            inline_keyboard: [
                [{ text: `🍔 快餐模型${isTier1 ? ' ✅' : ''}`, callback_data: `${prefix}set_mode:${ModelTier.TIER_1}` }],
                [{ text: `📖 基础模型${isTier2 ? ' ✅' : ''}`, callback_data: `${prefix}set_mode:${ModelTier.TIER_2}` }],
                [{ text: `🎦 旗舰模型${isTier3 ? ' ✅' : ''}`, callback_data: `${prefix}set_mode:${ModelTier.TIER_3}` }],
                [{ text: `💎 尊享模型${isTier4 ? ' ✅' : ''}`, callback_data: `${prefix}set_mode:${ModelTier.TIER_4}` }],
                [{ text: "🔙 返回", callback_data: backCallback }]
            ]
        };
    }

    static createRegenerateKeyboard(messageId: number): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [
                    { text: "🔄 重新生成", callback_data: `regenerate:${messageId}` },
                    { text: "🆕 新的对话", callback_data: `new_chat:${messageId}` }
                ],
                [
                    { text: "💾 保存对话", callback_data: `save_dialogue:${messageId}` }
                ]
            ]
        };
    }

    static createRoleChannelKeyboard(url: string): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "📚 浏览角色图鉴", url: url }]
            ]
        };
    }

    static createSaveSnapshotKeyboard(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "⚡️ 直接保存", callback_data: "save_snapshot_direct" }]
            ]
        };
    }

    static createSnapshotPreviewKeyboard(snapshotId: string): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "🚀 继续聊天", callback_data: `restore_snapshot:${snapshotId}` }],
                [{ text: "🗑️ 删除记忆", callback_data: `delete_snapshot:${snapshotId}` }]
            ]
        };
    }
}