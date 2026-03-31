import fetch from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import type { ISTEngine, STContextData } from '../../core/ports/ISTEngine.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SimplePromptEngine';

interface EngineConfig {
    api_key_openai?: string;
    api_url_openai?: string;
    openai_model?: string;
    [key: string]: any;
}

/**
 * Lightweight ISTEngine implementation that bypasses the SillyTavern Core engine.
 *
 * Assembles prompts directly from character + history + user input and calls
 * the LLM API via node-fetch, eliminating the need for VirtualContext,
 * CoreFactory, and FetchInterceptor.
 *
 * Switch-back point: SessionManager._createSession()
 */
export class SimplePromptEngine implements ISTEngine {
    private config: EngineConfig = {};
    private characters: any[] = [];
    private chat: any[] = [];
    private abortController: AbortController | null = null;

    async initialize(): Promise<void> {
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Initialized (lightweight mode)' });
    }

    async loadContext(contextData: STContextData): Promise<void> {
        if (contextData.characters) {
            this.characters = contextData.characters;
        }
        if (contextData.chat) {
            this.chat = contextData.chat;
        }
        logger.debug({
            kind: 'sys',
            component: COMPONENT,
            message: 'Context loaded',
            meta: { characters: this.characters.length, chatMessages: this.chat.length },
        });
    }

    async setConfiguration(config: Record<string, any>): Promise<void> {
        Object.assign(this.config, config);
        logger.debug({
            kind: 'sys',
            component: COMPONENT,
            message: 'Configuration updated',
            meta: { model: this.config.openai_model },
        });
    }

    // ──────────────────── Prompt Assembly ────────────────────

    private _buildMessages(userInput: string): Array<{ role: string; content: any }> {
        const char = this.characters[0];
        const messages: Array<{ role: string; content: any }> = [];

        // 1. System Prompt (character persona)
        const systemPrompt = char?.data?.system_prompt || char?.system_prompt || '';
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // 2. First Message (character greeting) — dynamically injected, never stored in Redis
        const firstMes = char?.data?.first_mes || char?.first_mes || '';
        if (firstMes) {
            const historyFirstIsGreeting =
                this.chat.length > 0 &&
                this.chat[0].role === 'assistant' &&
                this.chat[0].content === firstMes;

            if (!historyFirstIsGreeting) {
                messages.push({ role: 'assistant', content: firstMes });
            }
        }

        // 3. History (already in OpenAI { role, content } format from SessionManager)
        for (const msg of this.chat) {
            messages.push({ role: msg.role, content: msg.content });
        }

        // 4. Current user input (with system-instruction enhancement applied by SimpleChat)
        messages.push({ role: 'user', content: userInput });

        return messages;
    }

    // ──────────────────── Network ────────────────────

    private _resolveTargetUrl(): string {
        const apiUrl = this.config.api_url_openai || 'https://api.openai.com/v1';
        const base = apiUrl.replace(/\/$/, '');
        return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    }

    private _buildRequestBody(messages: Array<{ role: string; content: any }>, stream: boolean): any {
        const model = this.config.openai_model;
        const targetUrl = this._resolveTargetUrl();
        const openRouterChatUrl = 'https://openrouter.ai/api/v1/chat/completions';
        const isOpenRouter = targetUrl === openRouterChatUrl;

        // Inject cache_control only when routing through OpenRouter AND
        // the model is an Anthropic Claude variant (anthropic/claude-*).
        const isAnthropicClaude = typeof model === 'string' && model.startsWith('anthropic/claude');

        if (isOpenRouter && isAnthropicClaude) {
            // Breakpoint 1: system prompt
            for (const msg of messages) {
                if (msg.role === 'system' && typeof msg.content === 'string') {
                    msg.content = [{
                        type: 'text',
                        text: msg.content,
                        cache_control: { type: 'ephemeral' },
                    }];
                    break;
                }
            }

            // Breakpoint 2: the last message before current user input (tail of history).
            // This ensures that on the next turn, the entire prefix
            // (system + all prior history) can be served from cache,
            // and only the newly appended user message is billed at full price.
            if (messages.length >= 3) {
                const lastHistoryIdx = messages.length - 2;
                const lastHistoryMsg = messages[lastHistoryIdx];
                if (typeof lastHistoryMsg.content === 'string') {
                    lastHistoryMsg.content = [{
                        type: 'text',
                        text: lastHistoryMsg.content,
                        cache_control: { type: 'ephemeral' },
                    }];
                }
            }
        }

        const body: any = { model, messages, stream };

        return body;
    }

    private async _fetch(body: any, signal: AbortSignal): Promise<import('node-fetch').Response> {
        const targetUrl = this._resolveTargetUrl();
        const apiKey = this.config.api_key_openai || '';

        logger.info({
            kind: 'infra',
            component: COMPONENT,
            message: 'Sending API request',
            meta: { targetUrl, model: body.model },
        });

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            agent: new ProxyAgent(),
            signal: signal as any,
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'LLM API error',
                error: new Error(errText),
                meta: { status: response.status },
            });
            throw new Error(`LLM API ${response.status}: ${errText}`);
        }

        return response;
    }

    // ──────────────────── Non-streaming Generate ────────────────────

    async generate(prompt: string, trace?: any): Promise<any> {
        const messages = this._buildMessages(prompt);

        if (trace) {
            trace.finalContext = messages;
        }

        const body = this._buildRequestBody(messages, false);
        this.abortController = new AbortController();

        const fetchStart = Date.now();
        const response = await this._fetch(body, this.abortController.signal);
        const json: any = await response.json();

        logger.info({
            kind: 'infra',
            component: COMPONENT,
            message: 'Non-stream response received',
            meta: { latency: Date.now() - fetchStart },
        });

        if (trace) {
            trace.generation_id = json.id ?? null;
            trace.streamCompleted = true;
        }

        return json?.choices?.[0]?.message?.content ?? null;
    }

    // ──────────────────── Streaming Generate ────────────────────

    generateStream(prompt: string, trace?: any): AsyncIterable<string> {
        const self = this;

        async function* stream(): AsyncGenerator<string> {
            const messages = self._buildMessages(prompt);

            if (trace) {
                trace.finalContext = messages;
            }

            const body = self._buildRequestBody(messages, true);
            self.abortController = new AbortController();

            const fetchStart = Date.now();
            const response = await self._fetch(body, self.abortController.signal);

            logger.info({
                kind: 'infra',
                component: COMPONENT,
                message: 'Stream response headers received',
                meta: { status: response.status, ttfb: Date.now() - fetchStart },
            });

            yield* self._parseSSEStream(response, trace, fetchStart);
        }

        return stream();
    }

    // ──────────────────── SSE Parser (extracted from FetchInterceptor) ────────────────────

    private async *_parseSSEStream(
        response: import('node-fetch').Response,
        trace?: any,
        fetchStartMs?: number,
    ): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let isFirstChunk = true;

        const body = response.body;
        if (!body) {
            if (trace) trace.streamCompleted = true;
            return;
        }

        try {
            for await (const chunk of body as any) {
                buffer += decoder.decode(chunk, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const delta = this._extractDelta(line, trace, isFirstChunk, fetchStartMs);
                    if (delta === null) continue;
                    if (delta === '[DONE]') {
                        if (trace) trace.streamCompleted = true;
                        return;
                    }
                    if (isFirstChunk) isFirstChunk = false;
                    yield delta;
                }
            }

            // Flush remaining buffer
            if (buffer.trim().length > 0) {
                const delta = this._extractDelta(buffer, trace, isFirstChunk, fetchStartMs);
                if (delta && delta !== '[DONE]') {
                    yield delta;
                }
            }

            if (trace) trace.streamCompleted = true;
        } catch (error) {
            if (trace) trace.streamCompleted = false;
            throw error;
        }
    }

    private _extractDelta(
        line: string,
        trace?: any,
        isFirstChunk?: boolean,
        fetchStartMs?: number,
    ): string | null {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return null;
        const data = trimmed.slice(5).trim();
        if (!data) return null;
        if (data === '[DONE]') return '[DONE]';

        try {
            const payload = JSON.parse(data);

            if (trace) {
                if (payload.id && !trace.generation_id) {
                    trace.generation_id = payload.id;
                }
                if (payload.model && !trace.model_from_stream) {
                    trace.model_from_stream = payload.model;
                }
            }

            if (isFirstChunk) {
                logger.info({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Stream first token arrival',
                    meta: {
                        generationId: payload.id,
                        ttft: fetchStartMs ? Date.now() - fetchStartMs : undefined,
                    },
                });
            }

            const delta = payload?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
                return delta;
            }
            return null;
        } catch {
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'Failed to parse stream chunk' });
            return null;
        }
    }

    // ──────────────────── Abort ────────────────────

    abort(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            logger.info({ kind: 'sys', component: COMPONENT, message: 'Request aborted' });
        }
    }
}