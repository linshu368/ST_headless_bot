import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import type { Server } from 'http';
import { SimpleChat } from '../chat/usecases/SimpleChat.js';
import { ChannelRegistry } from '../../infrastructure/ai/ChannelRegistry.js';
import { SupabaseMessageRepository } from '../../infrastructure/repositories/SupabaseMessageRepository.js';
import { supabase } from '../../infrastructure/supabase/SupabaseClient.js';
import { SessionManager } from '../session/usecases/SessionManager.js';
import { ModelTier } from '../chat/domain/ModelStrategy.js';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import { RequestTimer } from '../../platform/RequestTimer.js';
import { generateTraceId, runWithTraceId, setUserId } from '../../platform/tracing.js';
import { UIHandler } from './UIHandler.js';
import { SupabaseUserRepository } from '../../infrastructure/repositories/SupabaseUserRepository.js';
import { runtimeConfig } from '../../infrastructure/runtime_config/RuntimeConfigService.js';
import { SupabaseCreditRepository } from '../../infrastructure/repositories/SupabaseCreditRepository.js';
import { getTotalBalance, InsufficientCreditsError } from '../credits/rules/creditCost.js';
import { PaymentUIHandler } from './PaymentUIHandler.js';
import { RechargeUseCase } from '../payment/usecases/RechargeUseCase.js';
import { calculateCreditsFromRecharge, formatCredits } from '../payment/domain/rechargeRules.js';
import { PAYMENT_METHODS, PaymentType } from '../../types/payment.js';
import type { InternalPaymentEvent } from '../../types/payment.js';

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
    private userRepository: SupabaseUserRepository;
    private creditsRepository: SupabaseCreditRepository | null;
    private rechargeUseCase: RechargeUseCase | null;
    private internalHttpServer: Server | null = null;
    private isPolling: boolean = false;
    private processedMessageIds: Set<number> = new Set();
    private readonly MAX_PROCESSED_IDS = 1000;
    
    // User State Management for Snapshot Naming
    // userId -> state (null | 'awaiting_snapshot_name')
    private userStates: Map<string, string> = new Map();

    // 已完成入账的订单号（幂等保护，防止重复入账）
    private processedOrderIds: Set<string> = new Set();

    // Per-User Concurrency Lock: 防止同一用户并发对话
    // chatId -> 加锁时间戳 (ms)
    private activeChats: Map<string, number> = new Map();
    private readonly LOCK_TIMEOUT_MS = 90_000;       // 锁最大存活时间 (兜底防泄漏)
    private readonly TIP_AUTO_DELETE_MS = 30_000;     // "请等待"提示自动删除时间

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
        
        // Initialize dependencies (SessionManager is singleton — shared across all components)
        this.sessionManager = new SessionManager();
        const channelRegistry = new ChannelRegistry();
        const messageRepository = new SupabaseMessageRepository();
        const creditsRepository = new SupabaseCreditRepository();
        this.simpleChat = new SimpleChat(this.sessionManager, channelRegistry, messageRepository, creditsRepository);
        this.userRepository = new SupabaseUserRepository();
        this.creditsRepository = creditsRepository;
        
        // 初始化充值用例（仅当支付功能启用时）
        this.rechargeUseCase = config.payment.enabled
            ? new RechargeUseCase(creditsRepository)
            : null;
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
        this.bot.on('callback_query', this._handleCallbackQuery.bind(this));

        await this.bot.startPolling({
            restart: true,
            polling: {
                params: {
                    timeout: 10
                }
            }
        });
        this.isPolling = true;
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Service is online' });

        // 启动内部 HTTP 服务器（接收支付 Service 转发的回调）
        if (config.payment.enabled) {
            this._startInternalApi();
        }
    }

    /**
     * 停止 Bot 服务
     */
    async stop(): Promise<void> {
        if (!this.isPolling) return;
        await this.bot.stopPolling();
        this.isPolling = false;

        if (this.internalHttpServer) {
            this.internalHttpServer.close();
            this.internalHttpServer = null;
        }

        logger.info({ kind: 'sys', component: COMPONENT, message: 'Service stopped' });
    }

    /**
     * 内部 HTTP API（仅供 Payment Service 调用）
     * 端点：POST /internal/payment-callback
     */
    private _startInternalApi(): void {
        const app = express();
        app.use(express.json());

        app.get('/health', (_req, res) => {
            res.json({ status: 'ok', service: 'bot-internal-api' });
        });

        app.post('/internal/payment-callback', async (req, res) => {
            const event = req.body as InternalPaymentEvent;
            const { userId, orderId, amount, paymentType } = event;

            if (!userId || !orderId || !amount) {
                res.status(400).json({ error: 'Missing required fields' });
                return;
            }

            logger.info({
                kind: 'biz', component: COMPONENT,
                message: 'Payment callback received from Payment Service',
                meta: { userId, orderId, amount, paymentType }
            });

            try {
                await this._handlePaymentSuccessInternal(userId, amount, orderId, paymentType);
                res.json({ success: true });
            } catch (error) {
                logger.error({
                    kind: 'sys', component: COMPONENT,
                    message: 'Internal payment callback processing error',
                    error, meta: { userId, orderId }
                });
                res.status(500).json({ error: 'Processing failed' });
            }
        });

        const port = config.payment.internalApiPort;
        this.internalHttpServer = app.listen(port, () => {
            logger.info({
                kind: 'sys', component: COMPONENT,
                message: `Internal API started on port ${port}`
            });
        });
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

            // 0.5 维护 bot_users 表（尽量不影响主流程）
            try {
                const from = msg.from;
                await this.userRepository.upsertTelegramUser({
                    userId: chatId,
                    username: from?.username ?? null,
                    firstName: from?.first_name ?? null,
                    lastName: from?.last_name ?? null,
                });
            } catch (error) {
                // Non-fatal: do not block chat flow
                logger.warn({ kind: 'infra', component: COMPONENT, message: 'Failed to upsert bot user (non-fatal)', error, meta: { chatId } });
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
            } else if (text === '💰 充值') {
                await this._handleRechargeMenu(chatId);
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

            // 4. 并发锁检查：同一用户同一时刻只允许处理一条对话消息
            const lockTime = this.activeChats.get(chatId);
            if (lockTime) {
                if (Date.now() - lockTime < this.LOCK_TIMEOUT_MS) {
                    // 用户有正在处理中的消息 → 拒绝并发送自动删除的提示
                    logger.info({ kind: 'biz', component: COMPONENT, message: 'Concurrent message blocked', meta: { chatId, messageId } });
                    const tipMsg = await this.bot.sendMessage(msg.chat.id, '⏳ 请等待上一条消息完成');
                    setTimeout(() => {
                        this.bot.deleteMessage(msg.chat.id, tipMsg.message_id).catch(() => {});
                    }, this.TIP_AUTO_DELETE_MS);
                    return;
                }
                // 锁已超时 → 视为泄漏，强制释放
                logger.warn({ kind: 'sys', component: COMPONENT, message: 'Stale chat lock cleared', meta: { chatId, staleDurationMs: Date.now() - lockTime } });
                this.activeChats.delete(chatId);
            }

            // 5. 普通对话处理（加锁）
            this.activeChats.set(chatId, Date.now());
            const startTime = Date.now();
            const timer = new RequestTimer();
            let placeholder: TelegramBot.Message | null = null;
            try {
                // 发送 "typing" 状态，提升用户体验
                this.bot.sendChatAction(msg.chat.id, 'typing');

                placeholder = await this.bot.sendMessage(msg.chat.id, '✍️输入中...');
                timer.mark('placeholder_sent');
                let lastText = '';
                let isFirstEdit = true;

                for await (const update of this.simpleChat.streamChat(chatId, text, timer)) {
                    if (!update.text || update.text.trim().length === 0 || update.text === lastText) continue;

                    await this.bot.editMessageText(update.text, {
                        chat_id: msg.chat.id,
                        message_id: placeholder.message_id
                    });

                    if (isFirstEdit) {
                        timer.mark('first_edit_done');
                        logger.info({
                            kind: 'biz',
                            component: COMPONENT,
                            message: 'First response waterfall',
                            meta: { waterfall: timer.toWaterfall(), chatId }
                        });
                        isFirstEdit = false;
                    }

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
                if (error instanceof InsufficientCreditsError && placeholder) {
                    const creditsMsg = await runtimeConfig.getInsufficientCreditsMessage();
                    await this.bot.editMessageText(creditsMsg, {
                        chat_id: msg.chat.id,
                        message_id: placeholder.message_id,
                        reply_markup: UIHandler.createRechargeKeyboard()
                    });
                    logger.info({ kind: 'biz', component: COMPONENT, message: 'Insufficient credits (chat)', meta: { chatId } });
                    return;
                }
                // 关键：完整暴露错误信息
                logger.error({ 
                    kind: 'sys', 
                    component: COMPONENT, 
                    message: 'Error handling message', 
                    error,  // 传入原始错误对象
                    meta: { chatId, text: text.slice(0, 50) } 
                });
                await this.bot.sendMessage(msg.chat.id, "抱歉，系统暂时出现故障，请稍后再试。");
            } finally {
                // 无论成功还是异常，必须释放锁
                this.activeChats.delete(chatId);
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
                    // 1. 发送欢迎语 + 底部按钮 (从 RuntimeConfig 动态获取)
                    const welcomeMessage = await runtimeConfig.getWelcomeMessage();
                    await this.bot.sendMessage(chatId, welcomeMessage, {
                        reply_markup: UIHandler.createRoleChannelKeyboard(config.supabase.roleChannelUrl),
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
• 点击“⚙️ 设置” 可切换AI模型

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
        const [currentMode, creditBalance] = await Promise.all([
            this.sessionManager.getUserModelMode(chatId),
            this.creditsRepository?.getBalance(chatId).catch(() => null) ?? Promise.resolve(null),
        ]);
        
        let modeText = "🎦 旗舰模型 (默认)";
        if (currentMode === ModelTier.TIER_1) modeText = "🍔 快餐模型";
        if (currentMode === ModelTier.TIER_2) modeText = "📖 基础模型";
        if (currentMode === ModelTier.TIER_3) modeText = "🎦 旗舰模型";
        if (currentMode === ModelTier.TIER_4) modeText = "💎 尊享模型";

        const totalCredits = creditBalance
            ? getTotalBalance(creditBalance.mainCredits, creditBalance.bonusCredits)
            : null;
        const balanceText = totalCredits === null ? '当前拥有星尘：--' : `当前拥有星尘：${totalCredits}`;
        const text = `⚙️ **设置中心**\n\n当前模型：**${modeText}**\n${balanceText}`;
        
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

        // Maintain user row for callback interactions as well (best-effort)
        try {
            const from = query.from;
            await this.userRepository.upsertTelegramUser({
                userId: chatId,
                username: from?.username ?? null,
                firstName: from?.first_name ?? null,
                lastName: from?.last_name ?? null,
            });
        } catch {
            // ignore
        }

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
                         if (error instanceof InsufficientCreditsError) {
                            const creditsMsg = await runtimeConfig.getInsufficientCreditsMessage();
                            await this.bot.editMessageText(creditsMsg, {
                                chat_id: chatId,
                                message_id: placeholder.message_id,
                                reply_markup: UIHandler.createRechargeKeyboard()
                            });
                            logger.info({ kind: 'biz', component: COMPONENT, message: 'Insufficient credits (regenerate)', meta: { chatId } });
                            await this.bot.answerCallbackQuery(query.id).catch(() => {});
                            break;
                        }
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

                // ========== 支付相关回调 ==========
                case 'pay_recharge':
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this._handleRechargeMenu(chatId);
                    await this.bot.answerCallbackQuery(query.id);
                    break;

                case 'pay_method':
                    await this._handlePaymentMethodSelect(chatId, params[0] as PaymentType, query);
                    break;

                case 'pay_amount':
                    await this._handlePaymentAmountSelect(chatId, parseInt(params[0]), params[1] as PaymentType, query);
                    break;

                case 'pay_check':
                    await this._handlePaymentStatusCheck(chatId, params[0], query);
                    break;

                case 'pay_back':
                    if (query.message?.message_id) {
                        await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    }
                    await this._handleRechargeMenu(chatId);
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
        let modeText = "🎦 旗舰模型 (默认)";
        if (currentMode === ModelTier.TIER_1) modeText = "🍔 快餐模型";
        if (currentMode === ModelTier.TIER_2) modeText = "📖 基础模型";
        if (currentMode === ModelTier.TIER_3) modeText = "🎦 旗舰模型";
        if (currentMode === ModelTier.TIER_4) modeText = "💎 尊享模型";

        const creditBalance = await this.creditsRepository?.getBalance(chatId).catch(() => null) ?? null;
        const totalCredits = creditBalance
            ? getTotalBalance(creditBalance.mainCredits, creditBalance.bonusCredits)
            : null;
        const balanceText = totalCredits === null ? '当前拥有星尘：--' : `当前拥有星尘：${totalCredits}`;
        const text = `⚙️ **设置中心**\n\n当前模型：**${modeText}**\n${balanceText}`;

        await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: UIHandler.createSettingsKeyboard(currentMode)
        });
    }

    private _getModelDisplayName(mode: string): string {
        if (mode === ModelTier.TIER_1) return '快餐模型';
        if (mode === ModelTier.TIER_2) return '基础模型';
        if (mode === ModelTier.TIER_3) return '旗舰模型';
        if (mode === ModelTier.TIER_4) return '尊享模型';
        return '旗舰模型';
    }

    // ========== 支付相关方法 ==========

    /**
     * 处理充值入口菜单
     */
    private async _handleRechargeMenu(chatId: string): Promise<void> {
        if (!this.rechargeUseCase) {
            await this.bot.sendMessage(chatId, '❌ 充值功能暂未开放');
            return;
        }

        const welcomeMsg = await PaymentUIHandler.getRechargeWelcomeMessage();
        await this.bot.sendMessage(chatId, welcomeMsg, {
            parse_mode: 'Markdown',
            reply_markup: PaymentUIHandler.createPaymentMethodKeyboard()
        });
    }

    /**
     * 处理支付方式选择 — 发送套餐图片 + 星尘档位按钮
     */
    private async _handlePaymentMethodSelect(
        chatId: string,
        paymentType: PaymentType,
        query: TelegramBot.CallbackQuery
    ): Promise<void> {
        const method = PAYMENT_METHODS.find(m => m.code === paymentType);
        if (!method) {
            await this.bot.answerCallbackQuery(query.id, { text: '无效的支付方式' });
            return;
        }

        if (!supabase) {
            await this.bot.answerCallbackQuery(query.id, { text: '系统配置错误' });
            return;
        }

        if (query.message?.message_id) {
            await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        }

        const { data } = supabase.storage.from('model_photo').getPublicUrl('credits_plan.png');

        await this.bot.sendPhoto(chatId, data.publicUrl, {
            caption: PaymentUIHandler.getCreditsSelectionCaption(),
            parse_mode: 'Markdown',
            reply_markup: await PaymentUIHandler.createCreditsPlansKeyboard(paymentType)
        });
        await this.bot.answerCallbackQuery(query.id);
    }

    /**
     * 处理充值金额选择
     */
    private async _handlePaymentAmountSelect(
        chatId: string,
        amount: number,
        paymentType: PaymentType,
        query: TelegramBot.CallbackQuery
    ): Promise<void> {
        if (!this.rechargeUseCase) {
            await this.bot.answerCallbackQuery(query.id, { text: '充值功能暂未开放' });
            return;
        }

        // 删除金额选择消息
        if (query.message?.message_id) {
            await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        }

        // 发送创建中提示
        const placeholder = await this.bot.sendMessage(chatId, '⏳ 正在创建订单...');

        // 创建订单
        const result = await this.rechargeUseCase.createRechargeOrder(chatId, amount, paymentType);

        if (result.success && result.paymentUrl && result.orderId) {
            const orderMsg = await PaymentUIHandler.getOrderCreatedMessage(result.orderId, amount, paymentType);
            await this.bot.editMessageText(
                orderMsg,
                {
                    chat_id: chatId,
                    message_id: placeholder.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: PaymentUIHandler.createPaymentOrderKeyboard(result.paymentUrl, result.orderId)
                }
            );
            logger.info({ kind: 'biz', component: COMPONENT, message: 'Recharge order created', 
                meta: { chatId, amount, paymentType, orderId: result.orderId } });
        } else {
            await this.bot.editMessageText(`❌ 创建订单失败：${result.errorMessage}`, {
                chat_id: chatId,
                message_id: placeholder.message_id
            });
        }

        await this.bot.answerCallbackQuery(query.id);
    }

    /**
     * 处理订单状态查询
     * 兜底机制：如果查询到已支付，主动触发积分入账（防止异步回调丢失）
     */
    private async _handlePaymentStatusCheck(
        chatId: string,
        orderId: string,
        query: TelegramBot.CallbackQuery
    ): Promise<void> {
        if (!this.rechargeUseCase) {
            await this.bot.answerCallbackQuery(query.id, { text: '充值功能暂未开放' });
            return;
        }

        const result = await this.rechargeUseCase.queryOrderStatus(orderId);
        await this.bot.answerCallbackQuery(query.id);

        if (result.status === 'paid' && result.amount) {
            await this._handlePaymentSuccessInternal(
                chatId, result.amount, orderId, result.paymentType || 'unknown'
            );
        } else {
            const statusMsg = await PaymentUIHandler.getOrderStatusMessage(orderId, result.status, result.paymentType, result.amount);
            await this.bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
        }
    }

    /**
     * 处理支付成功事件（由内部 API 或 pay_check 兜底触发）
     * 全部业务逻辑在 Bot Service 内完成：积分计算 → 入账 → Telegram 通知
     * 内置幂等保护：同一订单号只入账一次
     */
    private async _handlePaymentSuccessInternal(
        userId: string,
        amountStr: string,
        orderId: string,
        paymentType: string
    ): Promise<void> {
        // 幂等：同一订单号不重复入账
        if (this.processedOrderIds.has(orderId)) {
            logger.info({
                kind: 'biz', component: COMPONENT,
                message: 'Duplicate payment event ignored (already processed)',
                meta: { userId, orderId }
            });
            return;
        }

        const amountNum = parseFloat(amountStr);
        const { mainCredits, bonusCredits } = await calculateCreditsFromRecharge(amountNum);

        logger.info({
            kind: 'biz', component: COMPONENT,
            message: 'Processing payment success',
            meta: { userId, orderId, amount: amountNum, mainCredits, bonusCredits }
        });

        // 1. 积分入账
        const success = await this.creditsRepository?.addCredits(userId, mainCredits, bonusCredits) ?? false;

        if (!success) {
            logger.error({
                kind: 'biz', component: COMPONENT,
                message: 'Failed to add credits',
                meta: { userId, orderId }
            });
            return;
        }

        // 标记为已处理（幂等）
        this.processedOrderIds.add(orderId);

        logger.info({
            kind: 'biz', component: COMPONENT,
            message: 'Credits added successfully',
            meta: { userId, orderId, mainCredits, bonusCredits }
        });

        // 2. 发送 Telegram 通知
        const methodName = PaymentUIHandler.getPaymentMethodName(paymentType);
        const message = await PaymentUIHandler.getPaymentSuccessMessage(
            amountNum,
            orderId,
            methodName,
            formatCredits(mainCredits),
            bonusCredits > 0 ? formatCredits(bonusCredits) : '',
        );

        await this.bot.sendMessage(userId, message, { parse_mode: 'Markdown' })
            .catch(err => {
                logger.error({
                    kind: 'biz', component: COMPONENT,
                    message: 'Failed to send payment success notification',
                    error: err, meta: { userId, orderId }
                });
            });
    }
}
