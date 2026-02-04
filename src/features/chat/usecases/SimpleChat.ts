import { SessionManager, type OpenAIMessage } from '../../session/usecases/SessionManager.js';
import {
    applyStreamChar,
    createInitialStreamScheduleState,
} from '../rules/streamingSchedule.js';
import { logger } from '../../../platform/logger.js';
import type { IChannelRegistry } from '../ports/IChannelRegistry.js';
import { resolveChannelId, mapLegacyModeToTier } from '../domain/ModelStrategy.js';
import type { ISTEngine } from '../../../core/ports/ISTEngine.js';

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

    constructor(channelRegistry: IChannelRegistry) {
        this.sessionManager = new SessionManager();
        this.channelRegistry = channelRegistry;
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
        // Engine 内部负责将其转换为 ST 格式
        // 深拷贝以防止引用污染
        const historySnapshot = JSON.parse(JSON.stringify(session.history));
        logger.debug({ 
            kind: 'biz', 
            component: COMPONENT, 
            message: 'Injecting history into engine', 
            meta: {
                length: historySnapshot.length,
                tail: previewHistory(historySnapshot),
            }
        });
        
        await session.engine.loadContext({
            characters: [session.character],
            chat: historySnapshot
        });

        // 5. 触发生成 (Core Generation)
        // Engine 负责：填入 Input -> 触发 Generate -> 拦截网络 -> 返回文本
        let replyText: string;
        try {
            const rawReply = await session.engine.generate(userInput);
            
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
    async *streamChat(userId: string, userInput: string): AsyncGenerator<{
        text: string;
        isFirst: boolean;
        isFinal: boolean;
        firstResponseMs?: number;
    }> {
        logger.info({ kind: 'biz', component: COMPONENT, message: 'Streaming chat started' });

        const session = await this.sessionManager.getOrCreateSession(userId);

        // 使用通用生成器
        let accumulatedText = '';
        for await (const update of this._executeStreamGeneration(session, userInput, userId)) {
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
        for await (const update of this._executeStreamGeneration(session, lastUserContent, userId)) {
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
    private async *_executeStreamGeneration(session: any, userInput: string, userId: string): AsyncGenerator<{
        text: string;
        isFirst: boolean;
        isFinal: boolean;
        firstResponseMs?: number;
    }> {
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

        const historySnapshot = JSON.parse(JSON.stringify(session.history));
        
        await session.engine.loadContext({
            characters: [session.character],
            chat: historySnapshot
        });

        const startedAtMs = Date.now();
        let firstResponseMs: number | undefined;
        let accumulatedText = '';
        let lastSentText = '';
        let scheduleState = createInitialStreamScheduleState();

        try {
            // Resolve User Preference -> Tier -> Channel
            const userMode = await this.sessionManager.getUserModelMode(userId);
            const tier = mapLegacyModeToTier(userMode);
            const channelId = resolveChannelId(tier);
            const channel = this.channelRegistry.getChannel(channelId);

            if (!channel) {
                const error = new Error(`Channel configuration error: ${channelId} not found`);
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Channel resolution failed', error, meta: { userMode, tier, channelId } });
                throw error;
            }

            logger.info({ 
                kind: 'biz', 
                component: COMPONENT, 
                message: 'Starting generation via channel', 
                meta: { tier, channelId } 
            });

            // Delegate to Channel
            const stream = channel.streamGenerate(historySnapshot, { 
                engine: session.engine, 
                userInput: userInput 
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
                            firstResponseMs = nowMs - startedAtMs;
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
        } else {
            logger.error({ kind: 'biz', component: COMPONENT, message: 'Streaming returned empty' });
        }
    }

    /**
     * 调试用：导出当前会话历史
     */
    async getHistory(userId: string): Promise<any[]> {
        const session = await this.sessionManager.getOrCreateSession(userId);
        return session.history;
    }

}
