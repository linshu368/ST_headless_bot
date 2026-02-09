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
        if (currentMode === ModelTier.BASIC) {
            modeText = "🍔 基础模型";
        } else if (currentMode === ModelTier.STANDARD_A) {
            modeText = "📖 中级模型A";
        } else if (currentMode === ModelTier.STANDARD_B) {
            modeText = "🎦 中级模型B";
        }

        return {
            inline_keyboard: [
                [{ text: "🤖 模型选择", callback_data: "settings_model_select" }],
                [{ text: "关闭设置", callback_data: "close_settings" }]
            ]
        };
    }

    static createModelSelectionKeyboard(currentMode: string): TelegramBot.InlineKeyboardMarkup {
        const isBasic = currentMode === ModelTier.BASIC;
        const isStandardA = currentMode === ModelTier.STANDARD_A;
        const isStandardB = currentMode === ModelTier.STANDARD_B || (!isBasic && !isStandardA);

        return {
            inline_keyboard: [
                [{ text: `🎦 中级模型B${isStandardB ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.STANDARD_B}` }],
                [{ text: `🍔 基础模型${isBasic ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.BASIC}` }],
                [{ text: `📖 中级模型A${isStandardA ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.STANDARD_A}` }],
                [{ text: "🔙 返回", callback_data: "settings_main" }]
            ]
        };
    }

    static createRegenerateKeyboard(messageId: number): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: "🔄 重新生成", callback_data: `regenerate:${messageId}` }]
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
}

