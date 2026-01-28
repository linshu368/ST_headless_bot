import TelegramBot from 'node-telegram-bot-api';
import { SimpleChat } from '../chat/usecases/SimpleChat.js';
import config from '../../platform/config.js';

/**
 * Telegram Adapter (Layer 1 Interface)
 * 职责：
 * 1. 监听 TG 消息
 * 2. 路由指令 (/start, /reset)
 * 3. 调用 UseCase (SimpleChat)
 * 4. 发送回复
 */
export class TelegramBotAdapter {
    private bot: TelegramBot;
    private simpleChat: SimpleChat;
    private isPolling: boolean = false;
    private processedMessageIds: Set<number> = new Set();
    private readonly MAX_PROCESSED_IDS = 1000;

    constructor(token: string) {
        const requestOptions = {} as NonNullable<TelegramBot.ConstructorOptions['request']>;
        if (config.telegram.proxy) {
            const { scheme, host, port } = config.telegram.proxy;
            const proxyUrl = `${scheme}://${host}:${port}`;
            requestOptions.proxy = proxyUrl;
            console.log(`[TelegramBot] Using proxy: ${proxyUrl}`);
        }

        // 创建 Bot 实例 (Polling 模式)
        this.bot = new TelegramBot(token, {
            polling: false,
            request: requestOptions,
        }); // 先不自动开启 polling
        this.simpleChat = new SimpleChat();
    }

    /**
     * 启动 Bot 服务
     */
    async start(): Promise<void> {
        if (this.isPolling) {
            console.warn('[TelegramBot] Already polling.');
            return;
        }

        console.log('[TelegramBot] Starting polling...');
        
        // 注册事件处理
        this.bot.on('message', this._handleMessage.bind(this));
        this.bot.on('polling_error', (error) => console.error('[TelegramBot] Polling error:', error));

        await this.bot.startPolling();
        this.isPolling = true;
        console.log('[TelegramBot] Service is online.');
    }

    /**
     * 停止 Bot 服务
     */
    async stop(): Promise<void> {
        if (!this.isPolling) return;
        await this.bot.stopPolling();
        this.isPolling = false;
        console.log('[TelegramBot] Service stopped.');
    }

    /**
     * 核心消息处理器
     */
    private async _handleMessage(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id.toString(); // 使用 ChatID 作为 UserId (支持私聊)
        const text = msg.text;

        // 0. 去重处理 (幂等性)
        if (this.processedMessageIds.has(msg.message_id)) {
            console.log(`[TelegramBot] Ignoring duplicate message ${msg.message_id} from ${chatId}`);
            return;
        }
        this.processedMessageIds.add(msg.message_id);
        
        // 简单清理过期 ID
        if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
            const iterator = this.processedMessageIds.values();
            for (let i = 0; i < 100; i++) {
                const nextValue = iterator.next().value;
                if (nextValue !== undefined) {
                    this.processedMessageIds.delete(nextValue);
                }
            }
        }

        if (!text) return; // 忽略非文本消息

        console.log(`[TelegramBot] Received from ${chatId}: ${text}`);

        // 1. 指令处理
        if (text.startsWith('/')) {
            await this._handleCommand(chatId, text);
            return;
        }

        // 2. 普通对话处理
        try {
            // 发送 "typing" 状态，提升用户体验
            this.bot.sendChatAction(msg.chat.id, 'typing');

            const placeholder = await this.bot.sendMessage(msg.chat.id, '✍️输入中...');
            let lastText = '';

            for await (const update of this.simpleChat.streamChat(chatId, text)) {
                if (!update.text || update.text === lastText) continue;

                if (update.isFirst && update.firstResponseMs !== undefined) {
                    console.log(`[TelegramBot] First response in ${update.firstResponseMs}ms`);
                }

                await this.bot.editMessageText(update.text, {
                    chat_id: msg.chat.id,
                    message_id: placeholder.message_id
                });
                lastText = update.text;
            }

            if (!lastText) {
                await this.bot.editMessageText("收到空回复...", {
                    chat_id: msg.chat.id,
                    message_id: placeholder.message_id
                });
            }

        } catch (error) {
            console.error(`[TelegramBot] Error handling message for ${chatId}:`, error);
            await this.bot.sendMessage(msg.chat.id, "抱歉，系统暂时出现故障，请稍后再试。");
        }
    }

    /**
     * 指令路由器
     */
    private async _handleCommand(chatId: string, commandText: string): Promise<void> {
        const command = commandText.split(' ')[0].toLowerCase();

        switch (command) {
            case '/start':
                await this.bot.sendMessage(chatId, "欢迎！我是 Seraphina。直接发送消息即可开始对话。\n发送 /reset 可重置当前会话。");
                break;
            
            case '/reset':
                this.simpleChat.resetSession(chatId);
                await this.bot.sendMessage(chatId, "会话已重置，记忆已清除。");
                break;

            case '/help':
                await this.bot.sendMessage(chatId, "可用指令：\n/start - 开始\n/reset - 重置会话\n/help - 帮助");
                break;

            default:
                await this.bot.sendMessage(chatId, "未知指令。发送 /help 查看帮助。");
                break;
        }
    }
}

