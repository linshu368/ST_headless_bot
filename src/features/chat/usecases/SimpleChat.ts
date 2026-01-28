import { SessionManager, type OpenAIMessage } from '../../session/usecases/SessionManager.js';
import {
    applyStreamChar,
    createInitialStreamScheduleState,
} from '../rules/streamingSchedule.js';

/**
 * Layer 2 Usecase: 处理用户消息
 * 职责：
 * 1. 协调 SessionManager 获取会话
 * 2. 处理用户输入
 * 3. 调用 Engine 执行生成
 * 4. 更新历史记录
 */
export class SimpleChat {
    private sessionManager: SessionManager;

    constructor() {
        this.sessionManager = new SessionManager();
    }
    
    /**
     * 处理用户消息的主入口
     * @param userId Telegram 用户ID
     * @param userInput 用户输入的文本
     * @returns 机器人的回复文本
     */
    async chat(userId: string, userInput: string): Promise<string> {
        console.log(`[SimpleChat] Processing for user: ${userId}`);

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
        console.log('[SimpleChat] Pre-inject history snapshot (no user push yet)', {
            length: session.history.length,
            last: lastBeforeInject ? { role: lastBeforeInject.role, content: lastBeforeInject.content?.slice(0, 60) } : null,
            lastIsSameUserInput,
            tail: previewHistory(session.history),
        });

        // 4. 同步状态到 Layer 3 (Adapter)
        // 关键：将 Layer 2 的 OpenAI 格式历史注入到 Engine
        // Engine 内部负责将其转换为 ST 格式
        // 深拷贝以防止引用污染
        const historySnapshot = JSON.parse(JSON.stringify(session.history));
        console.log('[SimpleChat] Injecting history into engine', {
            length: historySnapshot.length,
            tail: previewHistory(historySnapshot),
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
                console.warn('[SimpleChat] Unexpected reply format:', rawReply);
                replyText = JSON.stringify(rawReply);
            }
            
        } catch (error) {
            console.error('[SimpleChat] Generation failed:', error);
            // 错误处理规约：返回固定错误提示，不崩溃
            return "我好像走神了... (Generation Error)";
        }

        if (replyText) {
            // 6. 更新 Layer 2 历史状态 (User + Bot)
            session.history.push({
                role: 'user',
                content: userInput
            });
            session.history.push({
                role: 'assistant',
                content: replyText
            });
            
            // 返回纯文本给 Layer 1 (Telegram)
            return replyText;
        } else {
            console.error('[SimpleChat] Generation returned empty');
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
        console.log(`[SimpleChat] Streaming for user: ${userId}`);

        const session = await this.sessionManager.getOrCreateSession(userId);

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
        console.log('[SimpleChat] Pre-inject history snapshot (no user push yet)', {
            length: session.history.length,
            last: lastBeforeInject ? { role: lastBeforeInject.role, content: lastBeforeInject.content?.slice(0, 60) } : null,
            lastIsSameUserInput,
            tail: previewHistory(session.history),
        });

        const historySnapshot = JSON.parse(JSON.stringify(session.history));
        console.log('[SimpleChat] Injecting history into engine', {
            length: historySnapshot.length,
            tail: previewHistory(historySnapshot),
        });

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
            const stream = session.engine.generateStream(userInput);

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
            console.error('[SimpleChat] Streaming generation failed:', error);
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
            session.history.push({
                role: 'user',
                content: userInput
            });
            session.history.push({
                role: 'assistant',
                content: accumulatedText
            });
        } else {
            console.error('[SimpleChat] Streaming returned empty');
        }
    }

    /**
     * 调试用：导出当前会话历史
     */
    async getHistory(userId: string): Promise<any[]> {
        const session = await this.sessionManager.getOrCreateSession(userId);
        return session.history;
    }

    /**
     * 手动重置会话
     */
    resetSession(userId: string): void {
        this.sessionManager.destroySession(userId);
    }
}

