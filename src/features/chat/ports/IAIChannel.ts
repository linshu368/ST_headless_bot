import type { OpenAIMessage } from '../../session/usecases/SessionManager.js';

/**
 * Layer C: Port - 对外部 AI 通道的能力声明
 */
export interface IAIChannel {
    /**
     * 流式生成回复
     * @param messages 上下文消息列表
     * @param context 执行上下文（包含 user_id, session_id 等元数据）
     */
    streamGenerate(messages: OpenAIMessage[], context?: Record<string, any>): AsyncGenerator<string>;
}
