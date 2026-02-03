import type { AIProfileConfig } from '../../../types/config.js';
import type { IAIChannel } from '../../../features/chat/ports/IAIChannel.js';
import type { ISTEngine } from '../../../core/ports/ISTEngine.js';
import { logger } from '../../../platform/logger.js';


export class PipelineChannel implements IAIChannel {
    constructor(
        private pipelineId: string,
        private steps: AIProfileConfig[]
    ) {}

    async *streamGenerate(messages: any[], context: any): AsyncGenerator<string> {
        const engine = context.engine as ISTEngine;
        const userInput = context.userInput as string;

        if (!engine || !userInput) {
            throw new Error('PipelineChannel requires engine and userInput in context');
        }

        // 顺序执行 Pipeline 中的 Profile
        for (let i = 0; i < this.steps.length; i++) {
            const profile = this.steps[i];
            const isLastAttempt = i === this.steps.length - 1;

            logger.info({ 
                kind: 'infra', 
                component: 'PipelineChannel', 
                message: `Executing pipeline step ${i + 1}/${this.steps.length}`,
                meta: { pipelineId: this.pipelineId, profileId: profile.id, model: profile.model }
            });

            try {
                // 1. 配置 Engine
                await engine.setConfiguration({
                    main_api: 'openai', // 假设目前都走 OpenAI 兼容协议
                    api_key_openai: profile.key,
                    api_url_openai: profile.url,
                    openai_model: profile.model,
                    // 还可以设置 timeout 等
                });

                // 2. 执行生成 (TODO: 实现 First Token Timeout)
                // 目前暂时直接调用，后续可以通过 FetchInterceptor 或封装 generateStream 实现超时控制
                const stream = engine.generateStream(userInput);

                let hasYielded = false;
                for await (const chunk of stream) {
                    hasYielded = true;
                    yield chunk;
                }

                // 如果流正常结束，则成功退出 Pipeline
                if (hasYielded) {
                    logger.info({ 
                        kind: 'infra', 
                        component: 'PipelineChannel', 
                        message: `Pipeline step success`,
                        meta: { pipelineId: this.pipelineId, profileId: profile.id }
                    });
                    return;
                } else {
                    // 如果流没内容，视为失败（除非这就是预期行为？）
                    throw new Error("Empty response stream");
                }

            } catch (error) {
                logger.warn({ 
                    kind: 'infra', 
                    component: 'PipelineChannel', 
                    message: `Pipeline step failed`,
                    error,
                    meta: { pipelineId: this.pipelineId, profileId: profile.id, attempt: i + 1 }
                });

                if (isLastAttempt) {
                    // 如果是最后一次尝试，则抛出异常，让上层处理兜底
                    logger.error({ 
                        kind: 'infra', 
                        component: 'PipelineChannel', 
                        message: `Pipeline execution failed after all attempts`,
                        meta: { pipelineId: this.pipelineId }
                    });
                    throw error;
                }
                // 否则继续下一次循环 (Retry)
            }
        }
    }
}
