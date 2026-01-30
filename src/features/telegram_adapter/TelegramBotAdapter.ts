import TelegramBot from 'node-telegram-bot-api';
import { SimpleChat } from '../chat/usecases/SimpleChat.js';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import { generateTraceId, runWithTraceId, setUserId } from '../../platform/tracing.js';

const COMPONENT = 'TelegramBot';

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
            logger.info({ kind: 'sys', component: COMPONENT, message: `Using proxy: ${proxyUrl}` });
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
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'Already polling' });
            return;
        }

        logger.info({ kind: 'sys', component: COMPONENT, message: 'Starting polling...' });
        
        // 注册事件处理
        this.bot.on('message', this._handleMessage.bind(this));
        this.bot.on('polling_error', (error) => {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Polling error', error });
        });

        await this.bot.startPolling();
        this.isPolling = true;
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Service is online' });
    }

    /**
     * 停止 Bot 服务
     */
    async stop(): Promise<void> {
        if (!this.isPolling) return;
        await this.bot.stopPolling();
        this.isPolling = false;
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Service stopped' });
    }

    /**
     * 核心消息处理器
     * 关键：使用 runWithTraceId 包裹，实现全链路追踪
     */
    private async _handleMessage(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id.toString(); // 使用 ChatID 作为 UserId (支持私聊)
        const text = msg.text;
        const messageId = msg.message_id;

        // 生成 Trace ID 并包裹整个处理流程
        const traceId = generateTraceId();
        
        await runWithTraceId(traceId, async () => {
            // 设置用户 ID 到上下文
            setUserId(chatId);

            // 0. 去重处理 (幂等性)
            if (this.processedMessageIds.has(messageId)) {
                logger.debug({ kind: 'sys', component: COMPONENT, message: 'Ignoring duplicate message', meta: { messageId, chatId } });
                return;
            }
            this.processedMessageIds.add(messageId);
            
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

            logger.info({ 
                kind: 'sys', 
                component: COMPONENT, 
                message: 'Message received', 
                meta: { chatId, text: text.slice(0, 100), messageId } 
            });

            // 1. 指令处理
            if (text.startsWith('/')) {
                await this._handleCommand(chatId, text);
                return;
            }

            // 2. 普通对话处理
            const startTime = Date.now();
            try {
                // 发送 "typing" 状态，提升用户体验
                this.bot.sendChatAction(msg.chat.id, 'typing');

                const placeholder = await this.bot.sendMessage(msg.chat.id, '✍️输入中...');
                let lastText = '';

                for await (const update of this.simpleChat.streamChat(chatId, text)) {
                    if (!update.text || update.text === lastText) continue;

                    if (update.isFirst && update.firstResponseMs !== undefined) {
                        logger.info({ 
                            kind: 'biz', 
                            component: COMPONENT, 
                            message: 'First response received', 
                            meta: { firstResponseMs: update.firstResponseMs } 
                        });
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
                    logger.warn({ kind: 'biz', component: COMPONENT, message: 'Empty reply from generation' });
                } else {
                    const latencyMs = Date.now() - startTime;
                    logger.info({ 
                        kind: 'biz', 
                        component: COMPONENT, 
                        message: 'Chat completed', 
                        meta: { replyLength: lastText.length, latencyMs } 
                    });
                }

            } catch (error) {
                // 关键：完整暴露错误信息
                logger.error({ 
                    kind: 'sys', 
                    component: COMPONENT, 
                    message: 'Error handling message', 
                    error,  // 传入原始错误对象
                    meta: { chatId, text: text.slice(0, 50) } 
                });
                await this.bot.sendMessage(msg.chat.id, "抱歉，系统暂时出现故障，请稍后再试。");
            }
        });
    }

    /**
     * 指令路由器
     */
    private async _handleCommand(chatId: string, commandText: string): Promise<void> {
        const command = commandText.split(' ')[0].toLowerCase();

        logger.info({ kind: 'biz', component: COMPONENT, message: 'Command received', meta: { command } });

        switch (command) {
            case '/start':
                await this.bot.sendMessage(chatId, "欢迎！我是 Seraphina。直接发送消息即可开始对话。");
                break;
            
            case '/help':
                await this.bot.sendMessage(chatId, "可用指令：\n/start - 开始\n/help - 帮助");
                break;

            default:
                logger.debug({ kind: 'biz', component: COMPONENT, message: 'Unknown command', meta: { command } });
                await this.bot.sendMessage(chatId, "未知指令。发送 /help 查看帮助。");
                break;
        }
    }
}
