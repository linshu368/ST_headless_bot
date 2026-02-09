import TelegramBot from 'node-telegram-bot-api';
import { SimpleChat } from '../chat/usecases/SimpleChat.js';
import { ChannelRegistry } from '../../infrastructure/ai/ChannelRegistry.js';
import { SessionManager } from '../session/usecases/SessionManager.js';
import { ModelTier } from '../chat/domain/ModelStrategy.js';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import { generateTraceId, runWithTraceId, setUserId } from '../../platform/tracing.js';
import { UIHandler } from './UIHandler.js';

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
    private sessionManager: SessionManager; // Add SessionManager
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
            polling: { autoStart: false }, // 明确禁止自动启动，完全由 start() 控制
            request: requestOptions,
        });
        
        // 关键防御：在实例创建后立即监听错误，防止未捕获的 Polling 异常导致进程崩溃
        this.bot.on('polling_error', (error) => {
            // 忽略常见的网络中断错误，让库自动重试
            if (error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT') || error.message.includes('socket disconnected')) {
                logger.warn({ kind: 'sys', component: COMPONENT, message: 'Network instability detected (auto-recovering)', error: error.message });
            } else {
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Polling fatal error', error });
            }
        });

        this.bot.on('error', (error) => {
             logger.error({ kind: 'sys', component: COMPONENT, message: 'General bot error', error });
        });
        
        // Initialize dependencies
        const channelRegistry = new ChannelRegistry();
        this.simpleChat = new SimpleChat(channelRegistry);
        this.sessionManager = new SessionManager(); // Initialize SessionManager
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
        this.bot.on('callback_query', this._handleCallbackQuery.bind(this)); // Register callback handler
        // Note: polling_error is already registered in constructor

        await this.bot.startPolling({
            restart: true, // 允许自动重启 polling
            polling: {
                params: {
                    timeout: 10 // 长轮询超时时间 (秒)
                }
            }
        });
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

            // 2. 菜单处理
            if (text === '⚙️ 设置') {
                await this._handleSettings(chatId);
                return;
            } else if (text === '❓ 帮助') {
                await this._handleHelp(chatId);
                return;
            } else if (text === '🎭 选择角色' || text === '🗂 历史聊天') {
                 if (text === '🎭 选择角色') {
                     await this._handleRoleSelection(chatId);
                 } else {
                     // TODO: History
                     await this.bot.sendMessage(chatId, "功能开发中...");
                 }
                 return;
            }

            // 3. 普通对话处理
            const startTime = Date.now();
            try {
                // 发送 "typing" 状态，提升用户体验
                this.bot.sendChatAction(msg.chat.id, 'typing');

                const placeholder = await this.bot.sendMessage(msg.chat.id, '✍️输入中...');
                let lastText = '';

                for await (const update of this.simpleChat.streamChat(chatId, text)) {
                    // Debug: Log raw update from LLM to investigate empty text issues
                    logger.info({
                        kind: 'biz',
                        component: COMPONENT,
                        message: 'Raw stream update received',
                        meta: { 
                            rawText: update.text, 
                            textLength: update.text?.length,
                            isFirst: update.isFirst
                        }
                    });

                    if (!update.text || update.text.trim().length === 0 || update.text === lastText) continue;

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

                    // 编辑最终消息，添加“重新生成”按钮
                    await this.bot.editMessageText(lastText, {
                        chat_id: msg.chat.id,
                        message_id: placeholder.message_id,
                        reply_markup: UIHandler.createRegenerateKeyboard(placeholder.message_id)
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
                const args = commandText.split(' ');
                let roleId = config.supabase.defaultRoleId;

                if (args.length > 1 && args[1].startsWith('role_')) {
                    roleId = args[1].replace('role_', '');
                }

                await this._handleStartRole(chatId, roleId);
                break;
            
            case '/help':
                await this._handleHelp(chatId);
                break;

            default:
                logger.debug({ kind: 'biz', component: COMPONENT, message: 'Unknown command', meta: { command } });
                await this.bot.sendMessage(chatId, "未知指令。发送 /help 查看帮助。");
                break;
        }
    }

    private async _handleRoleSelection(chatId: string): Promise<void> {
        const text = `🎭 **选择你的专属角色**

📚 在角色图鉴频道中浏览海量精品角色：
• 🌟 经典人物角色
• 💖 恋爱互动角色
• 🎮 游戏动漫角色
• ✨ 更多精品角色...

💡 点击下方按钮进入角色图鉴频道 👇`;
        
        await this.bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: UIHandler.createRoleChannelKeyboard(config.supabase.roleChannelUrl)
        });
    }

    private async _handleStartRole(chatId: string, roleId: string): Promise<void> {
        try {
             // 1. Switch Character
            const character = await this.sessionManager.switchCharacter(chatId, roleId);
            
            // 2. Construct Preview Message
            // Ensure post_link is valid
            const postLink = character.extensions?.post_link;
            
            const firstMes = character.first_mes || "你好！";
            
            logger.info({ kind: 'biz', component: COMPONENT, message: 'Role started', meta: { roleId, postLink } });

            // 3. Send Message
            // Step 1: Send Preview Card (if link exists)
            if (postLink) {
                // Sending link with preview enabled
                // Text can be customized, e.g., "Returning to Channel..." or hidden character name
                await this.bot.sendMessage(chatId, `<a href="${postLink}">回到角色卡频道</a>`, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: false,
                });
            }

            // Step 2: Send First Message
            await this.bot.sendMessage(chatId, firstMes, {
                disable_web_page_preview: true, // Disable preview for first message to avoid double previews
                reply_markup: UIHandler.createMainMenuKeyboard()
            });

        } catch (error) {
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Role switch failed', error });
            await this.bot.sendMessage(chatId, "抱歉，角色切换失败，请稍后再试。");
        }
    }

    private async _handleHelp(chatId: string): Promise<void> {
        const helpText = `❓ **帮助中心**

📚 **功能说明：**

💬 **对话功能**
• 直接发送消息与AI角色对话

⚙️ **设置**
• 点击“⚙️ 设置” 可切换AI回复模式（快餐/剧情）

💡 更多功能开发中，敬请期待...`;
        
        await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    }

    private async _handleSettings(chatId: string): Promise<void> {
        const currentMode = await this.sessionManager.getUserModelMode(chatId);
        
        let modeText = "🎦 中级模型B (默认)";
        if (currentMode === ModelTier.BASIC) modeText = "🍔 基础模型";
        if (currentMode === ModelTier.STANDARD_A) modeText = "📖 中级模型A";
        if (currentMode === ModelTier.STANDARD_B) modeText = "🎦 中级模型B";

        const text = `⚙️ **设置中心**\n\n当前模型：**${modeText}**`;
        
        await this.bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: UIHandler.createSettingsKeyboard(currentMode)
        });
    }

    private async _handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.data) return;
        const chatId = query.message?.chat.id.toString();
        if (!chatId) return;

        const action = query.data.split(':')[0];
        const params = query.data.split(':').slice(1);

        logger.info({ kind: 'biz', component: COMPONENT, message: 'Callback received', meta: { action, params } });

        try {
            switch (action) {
                case 'settings_main':
                    await this._updateSettingsMessage(query);
                    break;
                
                case 'settings_model_select':
                    const currentMode = await this.sessionManager.getUserModelMode(chatId);
                    await this.bot.editMessageText("请选择要切换的模型", {
                        chat_id: chatId,
                        message_id: query.message?.message_id,
                        reply_markup: UIHandler.createModelSelectionKeyboard(currentMode)
                    });
                    break;

                case 'set_mode':
                    const newMode = params[0];
                    await this.sessionManager.setUserModelMode(chatId, newMode);
                    await this.bot.answerCallbackQuery(query.id, { text: `✅ 已切换为：${this._getModelDisplayName(newMode)}` });
                    await this._updateSettingsMessage(query);
                    break;

                case 'close_settings':
                    await this.bot.deleteMessage(chatId, query.message?.message_id!);
                    break;

                case 'regenerate':
                    const originalMessageId = query.message?.message_id;
                    if (!originalMessageId) return;

                    // 1. 移除旧消息的按钮
                    await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                        chat_id: chatId,
                        message_id: originalMessageId
                    });

                    // 2. 发送新消息 Placeholder
                    const placeholder = await this.bot.sendMessage(chatId, '✍️ 重新生成中...');
                    let lastText = '';
                    const startTime = Date.now();

                    try {
                         // 3. 执行重新生成逻辑
                        for await (const update of this.simpleChat.streamRegenerate(chatId)) {
                            if (!update.text || update.text.trim().length === 0 || update.text === lastText) continue;

                            await this.bot.editMessageText(update.text, {
                                chat_id: chatId,
                                message_id: placeholder.message_id
                            });
                            lastText = update.text;
                        }

                        if (!lastText) {
                            await this.bot.editMessageText("重新生成失败 (空内容)", {
                                chat_id: chatId,
                                message_id: placeholder.message_id
                            });
                        } else {
                            // 4. 完成后添加按钮
                            await this.bot.editMessageText(lastText, {
                                chat_id: chatId,
                                message_id: placeholder.message_id,
                                reply_markup: UIHandler.createRegenerateKeyboard(placeholder.message_id)
                            });
                        }
                    } catch (error) {
                         logger.error({ kind: 'biz', component: COMPONENT, message: 'Regenerate flow failed', error });
                         // Prevent secondary error if network is down
                         await this.bot.editMessageText("重新生成遇到错误，请稍后再试。", {
                            chat_id: chatId,
                            message_id: placeholder.message_id
                        }).catch(() => {});
                    }
                    
                    await this.bot.answerCallbackQuery(query.id);
                    break;
            }
            } catch (error) {
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Callback handling error', error });
                // Prevent crash if answerCallbackQuery fails due to network issues
                await this.bot.answerCallbackQuery(query.id, { text: '操作失败，请重试' }).catch(() => {});
            }
    }

    private async _updateSettingsMessage(query: TelegramBot.CallbackQuery): Promise<void> {
        const chatId = query.message?.chat.id.toString();
        if (!chatId) return;

        const currentMode = await this.sessionManager.getUserModelMode(chatId);
        let modeText = "🎦 中级模型B (默认)";
        if (currentMode === ModelTier.BASIC) modeText = "🍔 基础模型";
        if (currentMode === ModelTier.STANDARD_A) modeText = "📖 中级模型A";
        if (currentMode === ModelTier.STANDARD_B) modeText = "🎦 中级模型B";

        const text = `⚙️ **设置中心**\n\n当前模型：**${modeText}**`;

        await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: UIHandler.createSettingsKeyboard(currentMode)
        });
    }

    private _getModelDisplayName(mode: string): string {
        if (mode === ModelTier.BASIC) return '基础模型';
        if (mode === ModelTier.STANDARD_A) return '中级模型A';
        if (mode === ModelTier.STANDARD_B) return '中级模型B';
        return '中级模型B';
    }
}
