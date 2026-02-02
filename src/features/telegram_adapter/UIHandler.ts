import TelegramBot from 'node-telegram-bot-api';
import { ModelTier } from '../chat/domain/ModelStrategy.js';

export class UIHandler {
    static createMainMenuKeyboard(): TelegramBot.ReplyKeyboardMarkup {
        return {
            keyboard: [
                [{ text: "🎭 选择角色" }],
                [{ text: "🗂 历史聊天" }],
                [{ text: "⚙️ 设置" }, { text: "❓ 帮助" }]
            ],
            resize_keyboard: true
        };
    }

    static createSettingsKeyboard(currentMode: string): TelegramBot.InlineKeyboardMarkup {
        let modeText = "🎦 中级模型B (默认)";
        if (currentMode === 'fast' || currentMode === ModelTier.BASIC) {
            modeText = "🍔 基础模型";
        } else if (currentMode === 'story' || currentMode === ModelTier.STANDARD) {
            modeText = "📖 中级模型A";
        }

        return {
            inline_keyboard: [
                [{ text: "🤖 模型选择", callback_data: "settings_model_select" }],
                [{ text: "关闭设置", callback_data: "close_settings" }]
            ]
        };
    }

    static createModelSelectionKeyboard(currentMode: string): TelegramBot.InlineKeyboardMarkup {
        const isBasic = currentMode === 'fast' || currentMode === ModelTier.BASIC;
        const isStandard = currentMode === 'story' || currentMode === ModelTier.STANDARD;
        const isPremium = currentMode === 'immersive' || currentMode === ModelTier.PREMIUM;

        return {
            inline_keyboard: [
                [{ text: `🎦 中级模型B${isPremium ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.PREMIUM}` }],
                [{ text: `🍔 基础模型${isBasic ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.BASIC}` }],
                [{ text: `📖 中级模型A${isStandard ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.STANDARD}` }],
                [{ text: "🔙 返回", callback_data: "settings_main" }]
            ]
        };
    }
}
