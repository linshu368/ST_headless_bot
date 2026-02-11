import TelegramBot from 'node-telegram-bot-api';
import { SimpleChat } from '../chat/usecases/SimpleChat.js';
import { ChannelRegistry } from '../../infrastructure/ai/ChannelRegistry.js';
import { SupabaseMessageRepository } from '../../infrastructure/repositories/SupabaseMessageRepository.js';
import { supabase } from '../../infrastructure/supabase/SupabaseClient.js';
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
    
    // User State Management for Snapshot Naming
    // userId -> state (null | 'awaiting_snapshot_name')
    private userStates: Map<string, string> = new Map();

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
        const messageRepository = new SupabaseMessageRepository();
        this.simpleChat = new SimpleChat(channelRegistry, messageRepository);
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
                     await this._handleListSnapshots(chatId);
                 }
                 return;
            }

            // 3. 状态机拦截 (快照命名)
            const userState = this.userStates.get(chatId);
            if (userState === 'awaiting_snapshot_name') {
                await this._handleSnapshotNaming(chatId, text);
                return;
            }

            // 4. 普通对话处理
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
                if (args.length > 1) {
                    const payload = args[1];
                    if (payload.startsWith('role_')) {
                        const roleId = payload.replace('role_', '');
                        await this._handleStartRole(chatId, roleId);
                    } else if (payload.startsWith('snap_')) {
                        const snapshotId = payload.replace('snap_', '');
                        await this._handleSnapshotPreview(chatId, snapshotId);
                    }
                } else {
                    // 1. 发送欢迎语 + 底部按钮
                    await this.bot.sendMessage(chatId, config.telegram.welcome_message, {
                        parse_mode: 'Markdown', // 确保 config 中的文案支持 Markdown
                        reply_markup: UIHandler.createRoleChannelKeyboard(config.supabase.roleChannelUrl)
                    });

                    // 2. 获取当前会话（包含默认角色）
                    const session = await this.sessionManager.getOrCreateSession(chatId);
                    
                    // 3. 发送角色预览 + 开场白
                    if (session.character) {
                        await this._sendCharacterGreeting(chatId, session.character);
                    }
                }
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
            
            logger.info({ kind: 'biz', component: COMPONENT, message: 'Role started', meta: { roleId } });

            // 2. Send Greeting (Preview + First Message)
            await this._sendCharacterGreeting(chatId, character);

        } catch (error) {
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Role switch failed', error });
            await this.bot.sendMessage(chatId, "抱歉，角色切换失败，请稍后再试。");
        }
    }

    /**
     * 发送角色问候语（预览卡片 + 开场白）
     */
    private async _sendCharacterGreeting(chatId: string, character: any): Promise<void> {
        // Ensure post_link is valid
        const postLink = character.extensions?.post_link;
        const firstMes = character.first_mes || "你好！";

        // Step 1: Send Preview Card (if link exists)
        if (postLink) {
            // Sending link with preview enabled
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
    }

    private async _handleHelp(chatId: string): Promise<void> {
        const helpText = `❓ **帮助中心**

📚 **功能说明：**

💬 **对话功能**
• 直接发送消息与AI角色对话

💾 **存档功能**
• 点击对话下方的 [💾 保存对话] 可保存当前进度
• 点击 [🗂 历史聊天] 可浏览和恢复存档

⚙️ **设置**
• 点击“⚙️ 设置” 可切换AI回复模式（快餐/剧情）

💡 更多功能开发中，敬请期待...`;
        
        await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    }

    private async _handleListSnapshots(chatId: string): Promise<void> {
        const snapshots = await this.sessionManager.getSnapshots(chatId);
        
        if (snapshots.length === 0) {
            await this.bot.sendMessage(chatId, "📭 暂无历史存档");
            return;
        }

        const botUsername = (await this.bot.getMe()).username;
        let messageText = "🗂 <b>历史对话存档</b>\n\n";

        snapshots.forEach((snap) => {
            const line = `<a href="https://t.me/${botUsername}?start=snap_${snap.id}">${snap.snapshot_name}</a>\n`;
            messageText += line;
        });

        await this.bot.sendMessage(chatId, messageText, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    }

    private async _handleSnapshotNaming(chatId: string, name: string): Promise<void> {
        // Clear state
        this.userStates.delete(chatId);

        // Execute Save
        const resultId = await this.sessionManager.createSnapshot(chatId, name);
        
        if (resultId) {
            await this.bot.sendMessage(chatId, `✅ 对话 **${name}** 已保存！`, { parse_mode: 'Markdown' });
        } else {
            await this.bot.sendMessage(chatId, "❌ 保存失败：当前没有可保存的对话。");
        }
    }

    private async _handleSnapshotPreview(chatId: string, snapshotId: string): Promise<void> {
        const snapshot = await this.sessionManager.getSnapshot(snapshotId);
        
        if (!snapshot) {
            await this.bot.sendMessage(chatId, "⚠️ 该记忆似乎已经消散了...");
            return;
        }

        // Step 1: Send Character Preview Card (if post_link exists)
        try {
            const character = await this.sessionManager.loadCharacterByRoleId(snapshot.role_id);
            const postLink = character?.extensions?.post_link;
            if (postLink) {
                await this.bot.sendMessage(chatId, `<a href="${postLink}">📼 ${snapshot.snapshot_name}</a>`, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: false,
                });
            }
        } catch (error) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Failed to load character for snapshot preview', error });
            // Non-fatal: continue without preview card
        }

        // Step 2: Send last assistant message + action buttons
        const lastAssistantMsg = snapshot.history.slice().reverse().find(m => m.role === 'assistant');
        const previewContent = lastAssistantMsg 
            ? (typeof lastAssistantMsg.content === 'string' ? lastAssistantMsg.content : "...") 
            : "(暂无对话记录)";

        await this.bot.sendMessage(chatId, previewContent, {
            disable_web_page_preview: true,
            reply_markup: UIHandler.createSnapshotPreviewKeyboard(snapshotId)
        });
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

    private async _handleModelSelection(chatId: string, previousMessageId?: number): Promise<void> {
        if (!supabase) {
            await this.bot.sendMessage(chatId, "⚠️ 系统配置错误：Supabase 未连接，无法加载图片。");
            return;
        }

        // 1. Delete previous message (Settings menu)
        if (previousMessageId) {
            await this.bot.deleteMessage(chatId, previousMessageId).catch(() => {});
        }

        // 2. Get Image URL
        // Assuming file name is 'model_class.png' in 'model_photo' bucket
        const { data } = supabase.storage.from('model_photo').getPublicUrl('model_class.png');
        
        // 3. Send Photo with Caption
        const currentMode = await this.sessionManager.getUserModelMode(chatId);
        const caption = UIHandler.getModelSelectionCaption();

        await this.bot.sendPhoto(chatId, data.publicUrl, {
            caption: caption,
            parse_mode: 'Markdown', // Ensure caption uses Markdown if needed, though caption entities are usually auto-detected or simple text.
            reply_markup: UIHandler.createModelSelectionKeyboard(currentMode)
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
                    await this._handleModelSelection(chatId, query.message?.message_id);
                    break;

                case 'set_mode':
                    const newMode = params[0];
                    await this.sessionManager.setUserModelMode(chatId, newMode);
                    await this.bot.answerCallbackQuery(query.id, { text: `✅ 已切换为：${this._getModelDisplayName(newMode)}` });
                    
                    // Delete the photo message and return to settings
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this._handleSettings(chatId);
                    break;

                case 'settings_back_from_model':
                    // Delete the photo message and return to settings
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this._handleSettings(chatId);
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

                case 'new_chat':
                    // 1. Get Session Info (for character title)
                    const session = await this.sessionManager.getOrCreateSession(chatId);
                    const characterTitle = session.character?.extensions?.title || session.character?.name || "未知角色";

                    // 2. Clear History
                    await this.sessionManager.resetSessionHistory(chatId);
                    
                    // 3. Remove buttons from the message that triggered this
                    if (query.message?.message_id) {
                        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                            chat_id: chatId,
                            message_id: query.message.message_id
                        }).catch(() => {});
                    }

                    // 4. Send confirmation
                    const newChatText = `🆕 已开启新对话\n\n💫 当前角色：**${characterTitle}**`;
                    await this.bot.sendMessage(chatId, newChatText, {
                        parse_mode: 'Markdown',
                        reply_markup: UIHandler.createMainMenuKeyboard()
                    });

                    await this.bot.answerCallbackQuery(query.id, { text: '已开启新对话' });
                    break;

                case 'save_dialogue':
                    // Prompt for name
                    this.userStates.set(chatId, 'awaiting_snapshot_name');
                    await this.bot.sendMessage(chatId, "💾 请发送本次存档的名称\n\n或者点击下方按钮自动命名保存：", {
                        reply_markup: UIHandler.createSaveSnapshotKeyboard()
                    });
                    await this.bot.answerCallbackQuery(query.id);
                    break;

                case 'save_snapshot_direct':
                    // 直接保存：用户命名部分为 "未命名"，时间戳由 SessionManager 自动生成
                    await this._handleSnapshotNaming(chatId, '未命名');
                    
                    // Remove the button
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this.bot.answerCallbackQuery(query.id);
                    break;

                case 'list_snapshots':
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this._handleListSnapshots(chatId);
                    await this.bot.answerCallbackQuery(query.id);
                    break;

                case 'delete_snapshot': // Format: delete_snapshot:{id}
                    // Extract ID is done via params earlier, but here we need to parse if it's "delete_snapshot:123"
                    // In handleCallbackQuery, action is split by :, so params[0] is id.
                    // But wait, the switch uses action.
                    // The action parsing logic is: const action = query.data.split(':')[0];
                    // So for "delete_snapshot:123", action is "delete_snapshot". Correct.
                    if (params.length > 0) {
                        const snapId = params[0];
                        const success = await this.sessionManager.deleteSnapshot(snapId);
                        if (success) {
                            await this.bot.answerCallbackQuery(query.id, { text: "🗑️ 记忆已删除" });
                            // Refresh list or delete message
                            if (query.message?.message_id) {
                                await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                            }
                            await this._handleListSnapshots(chatId);
                        } else {
                            await this.bot.answerCallbackQuery(query.id, { text: "❌ 删除失败" });
                        }
                    }
                    break;

                case 'restore_snapshot':
                    if (params.length > 0) {
                        const snapId = params[0];
                        const success = await this.sessionManager.restoreSnapshot(chatId, snapId);
                        if (success) {
                            await this.bot.answerCallbackQuery(query.id, { text: '✅ 记忆已恢复，请继续对话' });
                            // 只移除按钮，保留消息内容（角色卡预览 + 最后一条对话），方便用户看到上下文后继续对话
                            if (query.message?.message_id) {
                                await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                                    chat_id: chatId,
                                    message_id: query.message.message_id
                                }).catch(() => {});
                            }
                        } else {
                            await this.bot.answerCallbackQuery(query.id, { text: '❌ 恢复失败' });
                        }
                    }
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
