import { SessionManager, type OpenAIMessage } from '../../session/usecases/SessionManager.js';
import {
    applyStreamChar,
    createInitialStreamScheduleState,
} from '../rules/streamingSchedule.js';
import { logger } from '../../../platform/logger.js';
import type { RequestTimer } from '../../../platform/RequestTimer.js';
import type { IChannelRegistry } from '../ports/IChannelRegistry.js';
import type { IMessageRepository } from '../ports/IMessageRepository.js';
import { resolveTierFromMode } from '../domain/ModelStrategy.js';
import type { ISTEngine } from '../../../core/ports/ISTEngine.js';
import { runtimeConfig } from '../../../infrastructure/runtime_config/RuntimeConfigService.js';
import { PipelineChannel } from '../../../infrastructure/ai/channels/PipelineChannel.js';

const COMPONENT = 'SimpleChat';

/**
 * Layer 2 Usecase: 处理用户消息
 * 职责：
 * 1. 协调 SessionManager 获取会话
 * 2. 处理用户输入
 * 3. [Changed] 委托 Channel 执行生成
 * 4. 更新历史记录
 */
export class SimpleChat {
    private sessionManager: SessionManager;
    private channelRegistry: IChannelRegistry;
    private messageRepository: IMessageRepository;

    constructor(sessionManager: SessionManager, channelRegistry: IChannelRegistry, messageRepository: IMessageRepository) {
        this.sessionManager = sessionManager;
        this.channelRegistry = channelRegistry;
        this.messageRepository = messageRepository;
    }
    
    /**
     * 处理用户消息的主入口
     * @param userId Telegram 用户ID
     * @param userInput 用户输入的文本
     * @returns 机器人的回复文本
     */
    async chat(userId: string, userInput: string): Promise<string> {
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Processing chat request' });

        // 1. 获取会话 (Session Resolution)
        // 这一步涵盖了：检查缓存 -> (无) -> 加载角色 -> 初始化引擎 -> 返回会话
        const session = await this.sessionManager.getOrCreateSession(userId);

        // 2. 消息预处理 (Pre-processing)
        // MVP: 暂时跳过敏感词过滤等

        // 3. 历史快照（不提前写入当前用户输入）
        // 避免与 ST 内部 sendMessageAsUser 双写
        const previewHistory = (history: OpenAIMessage[], limit = 3) => {
            const tail = history.slice(-limit);
            return tail.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content.slice(0, 60) : String(m.content),
            }));
        };

        const lastBeforeInject = session.history[session.history.length - 1];
        const lastIsSameUserInput =
            lastBeforeInject?.role === 'user' && lastBeforeInject?.content === userInput;
        logger.debug({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'Pre-inject history snapshot', 
            meta: {
                length: session.history.length,
                last: lastBeforeInject ? { role: lastBeforeInject.role, content: lastBeforeInject.content?.slice(0, 60) } : null,
                lastIsSameUserInput,
                tail: previewHistory(session.history),
            }
        });

        // 4. 同步状态到 Layer 3 (Adapter)
        // 关键：将 Layer 2 的 OpenAI 格式历史注入到 Engine
        // [Modified] 直接传递历史记录，Prompt 组装由 SessionManager 配置的 Core 负责
        const contextToLoad = session.history;
        
        logger.debug({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'Injecting history into engine', 
            meta: {
                historyLength: session.history.length,
            }
        });
        
        await session.engine.loadContext({
            characters: [session.character],
            chat: contextToLoad
        });

        // 5. 触发生成 (Core Generation)
        // Engine 负责：填入 Input -> 触发 Generate -> 拦截网络 -> 返回文本
        let replyText: string;
        try {
            // Apply Prompt Injection
            // Calculate current round (approximate for non-streaming flow)
            // Note: In standard chat flow we assume it's a new turn
            const currentTurn = (session.turnCount || 0) + 1;
            const enhancedInput = await this._enhancePrompt(userInput, currentTurn);
            
            logger.debug({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Prompt enhanced', 
                meta: { currentTurn, originalLen: userInput.length, enhancedLen: enhancedInput.length } 
            });

            const rawReply = await session.engine.generate(enhancedInput);
            
            // Handle ST Message Object vs String
            if (typeof rawReply === 'object' && rawReply !== null && rawReply.mes) {
                replyText = rawReply.mes;
            } else if (typeof rawReply === 'string') {
                replyText = rawReply;
            } else {
                logger.warn({ 
                    kind: 'biz', 
                    component: COMPONENT, 
                    message: 'Unexpected reply format', 
                    meta: { rawReply: JSON.stringify(rawReply).slice(0, 200) } 
                });
                replyText = JSON.stringify(rawReply);
            }
            
        } catch (error) {
            // 关键：完整暴露错误信息
            logger.error({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Generation failed', 
                error  // 传入原始错误对象
            });
            // 错误处理规约：返回固定错误提示，不崩溃
            return "我好像走神了... (Generation Error)";
        }

        if (replyText) {
            // 6. 更新 Layer 2 历史状态 (User + Bot)
            await this.sessionManager.appendMessages(session, [
                {
                    role: 'user',
                    content: userInput
                },
                {
                    role: 'assistant',
                    content: replyText
                }
            ]);
            
            // 返回纯文本给 Layer 1 (Telegram)
            return replyText;
        } else {
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Generation returned empty' });
            return "收到空回复...";
        }
    }

    /**
     * 处理用户消息的流式入口
     * @param userId Telegram 用户ID
     * @param userInput 用户输入的文本
     * @returns 流式增量文本
     */
    async *streamChat(userId: string, userInput: string, timer?: RequestTimer): AsyncGenerator<{
        text: string;
        isFirst: boolean;
        isFinal: boolean;
        firstResponseMs?: number;
    }> {
        const processingStartTime = Date.now();
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Streaming chat started' });

        const session = await this.sessionManager.getOrCreateSession(userId, timer);

        // 使用通用生成器
        let accumulatedText = '';
        for await (const update of this._executeStreamGeneration(session, userInput, userId, 'normal', processingStartTime, timer)) {
            if (update.isFinal) {
                accumulatedText = update.text;
            }
            yield update;
        }

        // 保存历史 (Chat 特有: 追加 User + Bot)
        if (accumulatedText) {
            await this.sessionManager.appendMessages(session, [
                {
                    role: 'user',
                    content: userInput
                },
                {
                    role: 'assistant',
                    content: accumulatedText
                }
            ]);
        }
    }

    /**
     * 重新生成回复
     * @param userId Telegram 用户ID
     * @returns 流式增量文本
     */
    async *streamRegenerate(userId: string): AsyncGenerator<{
        text: string;
        isFirst: boolean;
        isFinal: boolean;
        firstResponseMs?: number;
    }> {
        const processingStartTime = Date.now();
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Regenerating chat started' });

        const session = await this.sessionManager.getOrCreateSession(userId);

        // 1. 回滚历史到最后一条用户消息
        const lastUserContent = await this.sessionManager.rollbackHistoryToLastUser(session);
        
        if (!lastUserContent) {
            logger.warn({ kind: 'biz', component: COMPONENT, message: 'Regenerate failed: No user message found' });
            yield { 
                text: "无法重新生成：找不到上一条用户消息。", 
                isFirst: true, 
                isFinal: true 
            };
            return;
        }

        // 2. 使用通用生成器 (使用回滚后的用户输入)
        let accumulatedText = '';
        for await (const update of this._executeStreamGeneration(session, lastUserContent, userId, 'regenerate', processingStartTime)) {
             if (update.isFinal) {
                accumulatedText = update.text;
            }
            yield update;
        }

        // 3. 保存历史 (Regenerate 特有: 只追加 Bot，因为 User 已经在回滚后的历史里了)
        if (accumulatedText) {
            await this.sessionManager.appendMessages(session, [
                {
                    role: 'assistant',
                    content: accumulatedText
                }
            ]);
        }
    }

    /**
     * 通用流式生成逻辑 (Private)
     */
    private async *_executeStreamGeneration(
        session: any, 
        userInput: string, 
        userId: string, 
        messageType: 'normal' | 'regenerate',
        processingStartTime: number,
        timer?: RequestTimer
    ): AsyncGenerator<{
        text: string;
        isFirst: boolean;
        isFinal: boolean;
        firstResponseMs?: number;
    }> {
        // [New] Capture history snapshot BEFORE generation
        const historySnapshot = JSON.stringify(session.history);
        const executionTrace = { 
            model: null as string | null, 
            attempt: null as number | null, 
            provider: null as string | null,
            finalContext: null as any,
            generation_id: null as string | null,
            apiKey: null as string | null
        };

        const previewHistory = (history: OpenAIMessage[], limit = 3) => {
            const tail = history.slice(-limit);
            return tail.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content.slice(0, 60) : String(m.content),
            }));
        };

        const lastBeforeInject = session.history[session.history.length - 1];
        const lastIsSameUserInput =
            lastBeforeInject?.role === 'user' && lastBeforeInject?.content === userInput;
        
        logger.debug({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'Pre-inject history snapshot', 
            meta: {
                length: session.history.length,
                last: lastBeforeInject ? { role: lastBeforeInject.role, content: lastBeforeInject.content?.slice(0, 60) } : null,
                lastIsSameUserInput,
                tail: previewHistory(session.history),
            }
        });

        // [Modified] 直接传递历史记录，Prompt 组装由 Core 负责
        const contextToLoad = session.history;
        
        // [Fix] Memory Correction for Regenerate
        // When regenerating, the history already contains the user input (due to rollback).
        // STEngine will append the userInput again, causing duplication.
        // So we must remove the last user message from the context loaded into the engine.
        let engineContext = contextToLoad;
        if (messageType === 'regenerate') {
            if (contextToLoad.length > 0 && contextToLoad[contextToLoad.length - 1].role === 'user') {
                engineContext = contextToLoad.slice(0, -1);
                 logger.debug({ 
                    kind: 'biz', 
                    component: COMPONENT, 
                    message: 'Regenerate mode: Removed last user message from engine context',
                    meta: { 
                        originalLength: contextToLoad.length,
                        newLength: engineContext.length
                    }
                });
            }
        }

        // Parallel: loadContext + all config lookups
        // (was 6+ sequential Redis calls → 1 parallel round)
        const [, userMode, aiConfigSource, systemInstructions, interChunkMs, totalMs] = await Promise.all([
            session.engine.loadContext({
                characters: [session.character],
                chat: engineContext
            }),
            this.sessionManager.getUserModelMode(userId),
            runtimeConfig.getAIConfigSource(),
            runtimeConfig.getSystemInstructions(),
            runtimeConfig.getStreamInterChunkTimeout(),
            runtimeConfig.getStreamTotalTimeout(),
        ]);
        timer?.mark('context_loaded');

        const startedAtMs = Date.now();
        let firstResponseMs: number | undefined;
        let accumulatedText = '';
        let lastSentText = '';
        let scheduleState = createInitialStreamScheduleState();
        let enhancedInput = '';

        try {
            // Resolve channel synchronously from pre-fetched config
            const tier = resolveTierFromMode(userMode);
            const channelId = aiConfigSource.tier_mapping[tier] || 'channel_3';
            const steps = aiConfigSource.channels[channelId];

            if (!Array.isArray(steps) || steps.length === 0) {
                const error = new Error(`Channel configuration error: ${channelId} not found`);
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Channel resolution failed', error, meta: { userMode, tier, channelId } });
                throw error;
            }

            const channel = new PipelineChannel(channelId, steps);

            const targetTurn = (session.turnCount || 0) + 1;
            enhancedInput = this._buildEnhancedPrompt(userInput, systemInstructions);

            timer?.mark('channel_resolved');
            logger.info({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Starting generation via channel', 
                meta: { tier, channelId, targetTurn } 
            });

            // Delegate to Channel (pass pre-fetched timeouts)
            const stream = channel.streamGenerate(contextToLoad, { 
                engine: session.engine, 
                userInput: enhancedInput,
                trace: executionTrace,
                timer,
                contextData: {
                    characters: [session.character],
                    chat: engineContext
                },
                timeoutConfig: { interChunkMs, totalMs }
            });

            for await (const chunk of stream) {
                if (!chunk) continue;

                for (const ch of chunk) {
                    accumulatedText += ch;
                    const nowMs = Date.now();
                    const { nextState, decision } = applyStreamChar(scheduleState, nowMs);
                    scheduleState = nextState;

                    if (decision?.shouldUpdate && accumulatedText !== lastSentText) {
                        if (decision.isFirstUpdate && firstResponseMs === undefined) {
                            firstResponseMs = nowMs - processingStartTime;
                            timer?.mark('first_yield');
                        }

                        lastSentText = accumulatedText;
                        yield {
                            text: accumulatedText,
                            isFirst: decision.isFirstUpdate,
                            isFinal: false,
                            firstResponseMs
                        };
                    }
                }
            }
        } catch (error) {
            logger.error({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Streaming generation failed', 
                error
            });
            throw error;
        }

        if (accumulatedText && accumulatedText !== lastSentText) {
            yield {
                text: accumulatedText,
                isFirst: false,
                isFinal: true,
                firstResponseMs
            };
            lastSentText = accumulatedText;
        } else if (accumulatedText) {
            yield {
                text: accumulatedText,
                isFirst: false,
                isFinal: true,
                firstResponseMs
            };
        }

        if (accumulatedText) {
            logger.info({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Streaming chat completed', 
                meta: { replyLength: accumulatedText.length, latencyMs: Date.now() - startedAtMs } 
            });

            // [New] Async Persist to Supabase (Fire-and-Forget)
            // Extract clean instructions from enhanced input
            let cleanInstructions = enhancedInput;
            const instructionMatch = enhancedInput.match(/##系统指令：以下为最高优先级指令。\n([\s\S]*?)\n##用户指令:/);
            if (instructionMatch && instructionMatch[1]) {
                cleanInstructions = instructionMatch[1].trim();
            }

            this.messageRepository.saveMessage({
                user_id: userId,
                role_id: session.character?.extensions?.role_id || null,
                user_input: userInput,
                bot_reply: accumulatedText,
                instructions: cleanInstructions,
                history: executionTrace.finalContext || historySnapshot,
                model_name: executionTrace.model,
                attempt_count: executionTrace.attempt,
                type: messageType,
                full_response: (Date.now() - startedAtMs) / 1000,
                first_response_latency: firstResponseMs ? firstResponseMs / 1000 : undefined
            }).then(messageId => {
                if (messageId && executionTrace.generation_id && executionTrace.apiKey) {
                    this._backfillOpenRouterStats(messageId, executionTrace.generation_id, executionTrace.apiKey).catch(err => {
                        logger.error({ kind: 'infra', component: COMPONENT, message: 'Backfill stats failed', error: err });
                    });
                }
            }).catch(err => {
                logger.error({ kind: 'infra', component: COMPONENT, message: 'Message persistence failed', error: err });
            });
        } else {
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Streaming returned empty' });
        }
    }

    /**
     * Sync prompt enhancement using pre-fetched instructions (hot path)
     */
    private _buildEnhancedPrompt(userInput: string, systemInstructions: string): string {
        return `##系统指令：以下为最高优先级指令。\n${systemInstructions}\n##用户指令:${userInput}\n`;
    }

    /**
     * Async prompt enhancement (fallback for non-streaming path)
     */
    private async _enhancePrompt(userInput: string, turnCount: number): Promise<string> {
        const system_instructions = await runtimeConfig.getSystemInstructions();
        return this._buildEnhancedPrompt(userInput, system_instructions);
    }

    /**
     * Backfill OpenRouter statistics asynchronously
     */
    private async _backfillOpenRouterStats(messageId: string, generationId: string, apiKey: string): Promise<void> {
        try {
            const statsUrl = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`;
            const maxAttempts = 6;
            const retryDelayMs = 1500;
            let stats: any = null;

            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const response = await fetch(statsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                    }
                });

                if (response.ok) {
                    const json = await response.json();
                    stats = json.data;
                    break;
                }

                if (response.status === 404 && attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                    continue;
                }

                logger.warn({ kind: 'infra', component: COMPONENT, message: 'OpenRouter stats fetch failed', meta: { status: response.status } });
                return;
            }

            if (stats) {
                await this.messageRepository.updateMessageStats(messageId, {
                    model: stats.model,
                    generation_time: (stats.generation_time || 0) / 1000, // ms -> s
                    latency: (stats.latency || 0) / 1000, // ms -> s
                    native_tokens_prompt: stats.native_tokens_prompt,
                    native_tokens_completion: stats.native_tokens_completion,
                    native_tokens_reasoning: stats.native_tokens_reasoning,
                    native_tokens_cached: stats.native_tokens_cached,
                    cache_discount: stats.cache_discount,
                    usage: stats.usage,
                    finish_reason: stats.finish_reason,
                    provider_name: stats.provider_name
                });
                logger.info({ kind: 'infra', component: COMPONENT, message: 'OpenRouter stats backfilled', meta: { messageId, generationId } });
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Error backfilling OpenRouter stats', error });
        }
    }

    async getHistory(userId: string): Promise<any[]> {
        const session = await this.sessionManager.getOrCreateSession(userId);
        return session.history;
    }

}
