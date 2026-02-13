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
        let modeText = "🎦 旗舰模型 (默认)";
        if (currentMode === ModelTier.TIER_1) {
            modeText = "🍔 快餐模型";
        } else if (currentMode === ModelTier.TIER_2) {
            modeText = "📖 基础模型";
        } else if (currentMode === ModelTier.TIER_3) {
            modeText = "🎦 旗舰模型";
        } else if (currentMode === ModelTier.TIER_4) {
            modeText = "💎 尊享模型";
        }

        return {
            inline_keyboard: [
                [{ text: "🤖 模型选择", callback_data: "settings_model_select" }],
                [{ text: "关闭设置", callback_data: "close_settings" }]
            ]
        };
    }

    static getModelSelectionCaption(): string {
        return `
━━━━━━━━━━━━
`;
    }

    static createModelSelectionKeyboard(currentMode: string): TelegramBot.InlineKeyboardMarkup {
        const isTier1 = currentMode === ModelTier.TIER_1;
        const isTier2 = currentMode === ModelTier.TIER_2;
        const isTier3 = currentMode === ModelTier.TIER_3;
        const isTier4 = currentMode === ModelTier.TIER_4;

        return {
            inline_keyboard: [
                [{ text: `🍔 快餐模型${isTier1 ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.TIER_1}` }],
                [{ text: `📖 基础模型${isTier2 ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.TIER_2}` }],
                [{ text: `🎦 旗舰模型${isTier3 ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.TIER_3}` }],
                [{ text: `💎 尊享模型${isTier4 ? ' ✅' : ''}`, callback_data: `set_mode:${ModelTier.TIER_4}` }],
                [{ text: "🔙 返回", callback_data: "settings_back_from_model" }]
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
