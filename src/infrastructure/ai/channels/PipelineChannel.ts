import type { AIProfileConfig } from '../../../types/config.js';
import type { IAIChannel } from '../../../features/chat/ports/IAIChannel.js';
import type { ISTEngine } from '../../../core/ports/ISTEngine.js';
import { logger } from '../../../platform/logger.js';
import config from '../../../platform/config.js';


export class PipelineChannel implements IAIChannel {
    constructor(
        private pipelineId: string,
        private steps: AIProfileConfig[]
    ) {}

    /**
     * Stage 1/2/3 Timeout Managed Stream
     */
    private async *managedStream(
        stream: AsyncIterable<string>,
        ttftMs: number,
        interChunkMs: number,
        totalMs: number,
        meta: any
    ): AsyncGenerator<string> {
        const startTime = Date.now();
        let hasReceivedFirstToken = false;
        
        // Use a wrapper to iterate the stream so we can race it
        const iterator = stream[Symbol.asyncIterator]();

        try {
            while (true) {
                const now = Date.now();
                const elapsed = now - startTime;
                const remainingTotal = totalMs - elapsed;
                
                // Stage 3: Total Timeout Check (Start of loop)
                if (remainingTotal <= 0) {
                    logger.warn({
                        kind: 'infra',
                        component: 'PipelineChannel',
                        message: 'Stream ended due to Total Timeout (Start)',
                        meta: { ...meta, duration: elapsed }
                    });
                    return;
                }

                // Determine deadline based on state
                // Stage 1 (TTFT) or Stage 2 (Inter-chunk)
                const stepTimeoutMs = hasReceivedFirstToken ? interChunkMs : ttftMs;
                
                // The effective timeout is the minimum of the step timeout and the remaining total time
                // This ensures Total Timeout interrupts a long pending chunk
                const effectiveTimeoutMs = Math.min(stepTimeoutMs, remainingTotal);
                
                let timer: NodeJS.Timeout;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error('TIMEOUT_RACE'));
                    }, effectiveTimeoutMs);
                });

                try {
                    // Race: Next Chunk vs Timeout
                    const result = await Promise.race([iterator.next(), timeoutPromise]);
                    clearTimeout(timer!);

                    if (result.done) {
                        break;
                    }

                    if (!hasReceivedFirstToken) {
                        const ttft = Date.now() - startTime;
                        logger.info({ 
                            kind: 'infra', 
                            component: 'PipelineChannel', 
                            message: 'ManagedStream: First Token Received', 
                            meta: { 
                                ttft, 
                                pipelineId: meta.pipelineId, 
                                profileId: meta.profileId 
                            } 
                        });
                        hasReceivedFirstToken = true;
                    }
                    
                    yield result.value;
                
                } catch (error: any) {
                    clearTimeout(timer!);

                    if (error.message === 'TIMEOUT_RACE') {
                        // Determine which timeout triggered
                        // If the remaining total time was the constraint (or close to it), it's a Total Timeout
                        // Re-calculate to be sure (allow 10ms buffer for execution time)
                        const currentElapsed = Date.now() - startTime;
                        const isTotalTimeout = currentElapsed >= totalMs - 10; 

                        if (isTotalTimeout) {
                             // Stage 3: Total Timeout -> Success (Truncate)
                             logger.warn({
                                kind: 'infra',
                                component: 'PipelineChannel',
                                message: 'Stream ended due to Total Timeout (Race)',
                                meta: { ...meta, duration: currentElapsed }
                            });
                            return;
                        }
                        
                        // Otherwise it was Step Timeout
                        if (!hasReceivedFirstToken) {
                            // Stage 1: TTFT Failure -> Throw to trigger retry
                            const reason = `TTFT timeout exceeded (${ttftMs}ms)`;
                            logger.info({ 
                                kind: 'infra', 
                                component: 'PipelineChannel', 
                                message: 'Step Failed: TTFT Timeout', 
                                meta: { 
                                    ttftMs, 
                                    duration: currentElapsed,
                                    pipelineId: meta.pipelineId, 
                                    profileId: meta.profileId 
                                } 
                            });
                            throw new Error(reason);
                        } else {
                            // Stage 2: Inter-chunk Timeout -> Success (Truncate)
                            logger.warn({
                                kind: 'infra',
                                component: 'PipelineChannel',
                                message: 'Stream ended due to Inter-chunk Timeout',
                                meta
                            });
                            return;
                        }
                    } else {
                        throw error;
                    }
                }
            }
        } finally {
            if (iterator.return) {
                await iterator.return();
            }
        }
    }

    async *streamGenerate(messages: any[], context: any): AsyncGenerator<string> {
        const engine = context.engine as ISTEngine;
        const userInput = context.userInput as string;
        const timer = context.timer;

        if (!engine || !userInput) {
            throw new Error('PipelineChannel requires engine and userInput in context');
        }

        // Use pre-fetched inter-chunk timeout if available (avoids extra config lookup)
        const preloaded = context.timeoutConfig;
        const interChunkDefaultMs = preloaded?.interChunkMs ?? config.timeouts.interChunk;

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
                // 0a. Reset trace fields that are per-step (prevents stale data from leaking across retries).
                // generation_id is set by FetchInterceptor during streaming with a write-once guard,
                // so we must clear it here to ensure each step captures its own generation_id.
                if (context?.trace) {
                    context.trace.generation_id = null;
                }

                // 0b. Reset engine state before retries to prevent chat pollution.
                // After a failed step, win.chat contains stale messages from the failed Generate().
                // Reloading context restores a clean chat state for the next attempt.
                if (i > 0 && context.contextData) {
                    logger.info({ 
                        kind: 'infra', 
                        component: 'PipelineChannel', 
                        message: 'Reloading engine context for retry',
                        meta: { pipelineId: this.pipelineId, step: i + 1 }
                    });
                    await engine.loadContext(context.contextData);
                }

                // 1. 配置 Engine
                await engine.setConfiguration({
                    main_api: 'openai', // 假设目前都走 OpenAI 兼容协议
                    api_key_openai: profile.key,
                    api_url_openai: profile.url,
                    openai_model: profile.model,
                    // 还可以设置 timeout 等
                });

                // 2. 执行生成 (Wrapped with 3-Stage Timeout)
                // [Trace] Pass context.trace to engine to capture final context
                const rawStream = engine.generateStream(userInput, context.trace);
                
                // Get timeouts from config/profile
                const ttftMs = profile.firstchunk_timeout || 7000; // Default 7s if not set
                const interChunkMs = interChunkDefaultMs || config.timeouts.interChunk;
                if (!profile.total_timeout) {
                    throw new Error(`Pipeline profile missing total_timeout: ${profile.id}`);
                }
                const totalMs = profile.total_timeout;
                logger.debug({
                    kind: 'infra',
                    component: 'PipelineChannel',
                    message: 'Pipeline timeout config resolved',
                    meta: {
                        pipelineId: this.pipelineId,
                        profileId: profile.id,
                        ttftMs,
                        interChunkMs,
                        totalMs,
                        sources: {
                            ttft: profile.firstchunk_timeout ? 'profile' : 'default',
                            interChunk: preloaded?.interChunkMs ? 'preloaded' : 'config.ts',
                            total: 'profile',
                        },
                    },
                });

                const managed = this.managedStream(
                    rawStream, 
                    ttftMs, 
                    interChunkMs, 
                    totalMs,
                    { pipelineId: this.pipelineId, profileId: profile.id }
                );

                let hasYielded = false;
                for await (const chunk of managed) {
                    if (!hasYielded) {
                        timer?.mark('first_token');
                    }
                    hasYielded = true;
                    yield chunk;
                }

                // 如果流正常结束（包括被截断的情况），则成功退出 Pipeline
                if (hasYielded) {
                    logger.info({ 
                        kind: 'infra', 
                        component: 'PipelineChannel', 
                        message: `Pipeline step success`,
                        meta: { pipelineId: this.pipelineId, profileId: profile.id }
                    });

                    // [Modified] Fill Trace Context
                    if (context && context.trace) {
                        context.trace.model = profile.model;
                        context.trace.attempt = i + 1;
                        //这里的provider不确定是用于记录那个字段，如果是供应啥元数据则不需要，可以删掉
                        context.trace.provider = profile.provider || 'unknown';
                        context.trace.apiKey = profile.key; // Capture API Key for backfill
                    }

                    return;
                } else {
                    // 如果流没内容（比如刚连上就断了，且没抛 TTFT），视为失败
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
                logger.info({ 
                    kind: 'infra', 
                    component: 'PipelineChannel', 
                    message: `Switching to next step due to failure`,
                    meta: { 
                        failedStep: i + 1,
                        reason: error instanceof Error ? error.message : String(error),
                        nextStep: i + 2
                    }
                });
            }
        }
    }
}
