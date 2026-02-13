import fs from 'fs';
import path from 'path';
import fetch, { Response } from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import globalConfig from '../../platform/config.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'FetchInterceptor';

export interface FetchInterceptorConfig {
    api_key_openai?: string;
    api_url_openai?: string;
    openai_model?: string;
    [key: string]: any;
}

export interface MockState {
    characters: any[];
    chats: any[];
}

export interface FetchInterceptor extends Function {
    (url: string | URL | Request, options?: any): Promise<Response | any>;
    setMockData: (data: Partial<MockState>) => void;
    setStreamMode?: (enabled: boolean) => void;
    setStreamSink?: (sink: StreamSink | null) => void;
    setConfig?: (config: FetchInterceptorConfig) => void;
    setTraceContext?: (trace: any) => void;
}

export interface StreamSink {
    onDelta: (text: string) => void;
    onComplete: () => void;
    onError: (error: Error) => void;
}

/**
 * Creates a fetch implementation that intercepts specific ST requests
 * and proxies others to the real network.
 * 
 * @param config - Configuration object (contains api_key, api_url, etc.)
 * @returns - The fetch function with .setMockData method
 */
export const createFetchInterceptor = (config: FetchInterceptorConfig): FetchInterceptor => {
    
    // Mutable State for Mock Data
    const mockState: MockState = {
        characters: [],
        chats: []
    };
    const mockSecrets: Record<string, string> = {};
    let mockSecretIdCounter = 0;
    let streamModeEnabled = false;
    let streamSink: StreamSink | null = null;
    let currentConfig: FetchInterceptorConfig = { ...config };
    let traceContext: any = null;

    const interceptor = (async (url: string | URL | Request, options: any = {}): Promise<Response | any> => {
        const urlStr = url.toString();
        const normalizedUrl = urlStr.startsWith('/') ? urlStr : `/${urlStr}`;
        const getRequestBody = () => {
            if (!options?.body) return {};
            if (typeof options.body === 'string') {
                try {
                    return JSON.parse(options.body);
                } catch {
                    return {};
                }
            }
            return options.body;
        };

        // 1. Intercept Ping
        if (urlStr === 'api/ping' || normalizedUrl === '/api/ping') {
            logger.debug({ kind: 'sys', component: COMPONENT, message: 'Hijacked ping' });
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                json: async () => ({}),
                text: async () => '{}',
            };
        }
        
        // 2. Intercept Character Fetch (Crucial for Initialization)
        if (normalizedUrl === '/api/characters/all') {
            logger.debug({ kind: 'sys', component: COMPONENT, message: 'Hijacked /api/characters/all', meta: { count: mockState.characters.length } });
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => mockState.characters
            };
        }
        
        // 3. Intercept Chat Fetch
        if (normalizedUrl === '/api/chats/get') {
            logger.debug({ kind: 'sys', component: COMPONENT, message: 'Hijacked /api/chats/get', meta: { count: mockState.chats.length } });
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => mockState.chats
            };
        }
    
        // 3.1 Intercept Stats
        if (normalizedUrl.includes('/api/stats/get') || normalizedUrl.includes('/api/stats/update')) {
            return {
                ok: true,
                json: async () => ({})
            };
        }

        // 3.1.1 Intercept Secrets (in-memory mock)
        if (normalizedUrl === '/api/secrets/read') {
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ ...mockSecrets })
            };
        }
        if (normalizedUrl === '/api/secrets/write') {
            const body = getRequestBody();
            if (body?.key && typeof body.value === 'string') {
                mockSecrets[String(body.key)] = body.value;
            }
            mockSecretIdCounter += 1;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ id: `mock-${mockSecretIdCounter}` })
            };
        }
        if (normalizedUrl === '/api/secrets/delete') {
            const body = getRequestBody();
            if (body?.key) {
                delete mockSecrets[String(body.key)];
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({})
            };
        }
        if (normalizedUrl === '/api/secrets/find') {
            const body = getRequestBody();
            const value = body?.key ? mockSecrets[String(body.key)] ?? null : null;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ value })
            };
        }
    
        // 3.2 Intercept Chat Save
        if (normalizedUrl === '/api/chats/save') {
            logger.debug({ kind: 'sys', component: COMPONENT, message: 'Hijacked /api/chats/save' });
            // Ideally we should update mockState.chats here if we want persistence simulation
            return {
                ok: true,
                status: 200,
                json: async () => ({})
            };
        }
    
        // 3.3 Intercept Chat Generation (Proxy to Real LLM)
        if (normalizedUrl === '/api/backends/chat-completions/generate') {
            logger.info({ kind: 'sys', component: COMPONENT, message: 'Intercepted chat generation request' });
            try {
                // Determine Configuration (Dynamic config takes precedence over Global/Env config)
                // This allows PipelineChannel to switch profiles effectively
                const apiKey = currentConfig.api_key_openai || globalConfig.openai.apiKey;
                const apiUrl = currentConfig.api_url_openai || globalConfig.openai.apiUrl || 'https://api.openai.com/v1';
                const model = currentConfig.openai_model || globalConfig.openai.model;

                const baseUrl = apiUrl.replace(/\/$/, '');
                const targetUrl = baseUrl.endsWith('/chat/completions')
                    ? baseUrl
                    : `${baseUrl}/chat/completions`;
                const openRouterChatUrl = 'https://openrouter.ai/api/v1/chat/completions';
                
                logger.info({ kind: 'sys', component: COMPONENT, message: 'Forwarding to LLM', meta: { targetUrl, model } });
                
                // Prepare Headers
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };

                // Parse and Prepare Body
                let requestBody: any = {};
                try {
                    requestBody = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                } catch (e) {
                    logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to parse request body', error: e });
                }

                const bodyKeys = requestBody ? Object.keys(requestBody) : [];
                const messageCount = Array.isArray(requestBody?.messages) ? requestBody.messages.length : 0;
                
                logger.debug({ 
                    kind: 'sys', 
                    component: COMPONENT, 
                    message: 'LLM request details', 
                    meta: { 
                        bodyKeys: bodyKeys.join(', ') || '(empty)', 
                        messageCount,
                        firstMessage: requestBody.messages?.[0] ? {
                            role: requestBody.messages[0].role,
                            content: requestBody.messages[0].content?.slice(0, 100)
                        } : null,
                        lastMessage: requestBody.messages?.length > 1 ? {
                            role: requestBody.messages[requestBody.messages.length - 1].role,
                            content: requestBody.messages[requestBody.messages.length - 1].content?.slice(0, 100)
                        } : null
                    } 
                });
               
                // Force override model
                if (model) {
                    logger.debug({ kind: 'sys', component: COMPONENT, message: 'Overriding model', meta: { from: requestBody.model, to: model } });
                    requestBody.model = model;
                }

                // Ensure chat-completions has messages. Some ST flows may send prompt-like fields.
                if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
                    const fallbackPrompt = requestBody.prompt ?? requestBody.text ?? requestBody.input;
                    if (fallbackPrompt) {
                        requestBody.messages = [{
                            role: 'user',
                            content: String(fallbackPrompt)
                        }];
                    }
                }

                // [FIX] Prompt Reconstruction — ST Core's PromptManager is broken in headless mode.
                // It produces messages in reverse chronological order with no system prompt.
                // We fix this here as the last checkpoint before the LLM API:
                //   1. Reverse the array to restore chronological order
                //   2. Prepend character.system_prompt as a system message
                if (Array.isArray(requestBody.messages) && requestBody.messages.length > 0
                    && requestBody.messages[0].role !== 'system'
                    && mockState.characters.length > 0) {
                    
                    const char = mockState.characters[0];
                    const systemPrompt = char.data?.system_prompt || char.system_prompt || '';
                    
                    // Reverse: ST Core outputs newest-first, we need oldest-first (chronological)
                    requestBody.messages.reverse();

                    // Prepend system prompt if available
                    if (systemPrompt) {
                        requestBody.messages.unshift({
                            role: 'system',
                            content: systemPrompt
                        });
                    }

                    // Clean up ST-internal metadata fields that LLM APIs don't understand
                    for (const msg of requestBody.messages) {
                        delete msg.name;
                        delete msg.mediaDisplay;
                        delete msg.mediaIndex;
                    }

                    logger.info({ 
                        kind: 'sys', 
                        component: COMPONENT, 
                        message: 'Prompt reconstructed (reversed + system_prompt prepended)', 
                        meta: { 
                            totalMessages: requestBody.messages.length,
                            hasSystemPrompt: !!systemPrompt,
                            systemPromptPreview: systemPrompt.slice(0, 150)
                        } 
                    });
                }

                if (streamModeEnabled) {
                    requestBody.stream = true;
                }

                // Remove max_tokens to allow model to determine length
                if (requestBody.max_tokens) {
                    delete requestBody.max_tokens;
                }

                if (targetUrl === openRouterChatUrl) {
                    requestBody.provider = {
                        sort: 'latency',
                        ignore: [
                            'wandb',
                            'deepinfra',
                            'sambanova',
                            'siliconflow'
                        ]
                    };
                }

                // [ADDED] Log the full prompt and request body for debugging
                logger.info({
                    kind: 'sys',
                    component: COMPONENT,
                    message: 'Constructed LLM Request Body',
                    meta: {
                        messages: requestBody.messages,
                        params: {
                            model: requestBody.model || model,
                            temperature: requestBody.temperature,
                            max_tokens: requestBody.max_tokens,
                            stream: requestBody.stream
                        }
                    }
                });

                // [ADDED] Capture final context if trace is available
                if (traceContext) {
                    traceContext.finalContext = requestBody.messages;
                    logger.debug({ kind: 'sys', component: COMPONENT, message: 'Captured final context for trace', meta: { messageCount: requestBody.messages?.length } });
                }

                const bodyStr = JSON.stringify(requestBody);
                
                // Real Request to LLM
                // Note: We use the real 'fetch' here, not the intercepted one (recursion avoidance)
                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: headers,
                    body: bodyStr,
                    agent: new ProxyAgent()
                });

                if (!response.ok) {
                    const errText = await response.text();
                    // 关键：完整暴露 LLM API 错误
                    logger.error({ 
                        kind: 'sys', 
                        component: COMPONENT, 
                        message: 'LLM API error', 
                        error: new Error(errText),
                        meta: { status: response.status, statusText: response.statusText }
                    });
                    if (streamSink) {
                        streamSink.onError(new Error(errText));
                    }
                    return {
                        ok: false,
                        status: response.status,
                        statusText: response.statusText,
                        text: async () => errText,
                        json: async () => { try { return JSON.parse(errText) } catch(e) { return {error: errText} } }
                    };
                }

                if (streamModeEnabled) {
                    const fullText = await parseOpenAIStream(response, streamSink, traceContext);
                    const responseBody = buildChatCompletionResponse(fullText, requestBody.model || model);
                    return new Response(JSON.stringify(responseBody), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // Return the real response stream directly
                return response;
    
            } catch (err: any) {
                // 关键：完整暴露原始错误
                logger.error({ 
                    kind: 'sys', 
                    component: COMPONENT, 
                    message: 'Chat generation proxy failed', 
                    error: err  // 传入原始错误对象
                });
                if (streamSink) {
                    streamSink.onError(err instanceof Error ? err : new Error(String(err)));
                }
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Error',
                    text: async () => err.toString(),
                    json: async () => ({ error: err.toString() })
                };
            }
        }

        // 3.4 Intercept Chat Status (Always Connected)
        if (normalizedUrl === '/api/backends/chat-completions/status') {
            logger.debug({ kind: 'sys', component: COMPONENT, message: 'Hijacked chat status' });
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({
                    data: [],
                    bypass: true
                })
            };
        }
    
        // 4. Fallback: Serve Static Files (Crucial for Templates, WASM, etc.)
        if (!urlStr.startsWith('http')) {
            try {
                const cleanUrl = urlStr.split('?')[0];
                const relativePath = cleanUrl.startsWith('/') ? cleanUrl.slice(1) : cleanUrl;
                const filePath = path.join(process.cwd(), 'public', relativePath);
                
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath); 
                    return {
                        ok: true,
                        status: 200,
                        headers: { get: () => null },
                        arrayBuffer: async () => {
                            const buf = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
                            return buf;
                        },
                        text: async () => content.toString('utf-8'), 
                        json: async () => JSON.parse(content.toString('utf-8')), 
                        blob: async () => ({ arrayBuffer: async () => content.buffer }), 
                    };
                } else {
                    return {
                        ok: false,
                        status: 404,
                        headers: { get: () => null },
                        text: async () => 'Not Found',
                        json: async () => ({}),
                    };
                }
            } catch (fileErr) {
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Static file error', error: fileErr });
                return {
                    ok: false,
                    status: 500,
                    headers: { get: () => null },
                    text: async () => 'Internal Error',
                    json: async () => ({}),
                };
            }
        }
    
        // Pass through other HTTP requests
        try {
            // @ts-ignore
            return await fetch(url, options);
        } catch (error) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Request failed', error });
            throw error;
        }
    }) as FetchInterceptor;

    interceptor.setMockData = (data: Partial<MockState>) => {
        if (data.characters) mockState.characters = data.characters;
        if (data.chats) mockState.chats = data.chats;
    };

    interceptor.setStreamMode = (enabled: boolean) => {
        streamModeEnabled = enabled;
    };

    interceptor.setStreamSink = (sink: StreamSink | null) => {
        streamSink = sink;
    };

    interceptor.setConfig = (newConfig: FetchInterceptorConfig) => {
        logger.debug({ kind: 'sys', component: COMPONENT, message: 'Updating FetchInterceptor config', meta: { newConfig } });
        currentConfig = { ...currentConfig, ...newConfig };
    };

    interceptor.setTraceContext = (trace: any) => {
        traceContext = trace;
    };

    return interceptor;
};

const parseOpenAIStream = async (response: Response, sink: StreamSink | null, traceContext?: any): Promise<string> => {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    try {
        const body = response.body;
        if (!body) {
            sink?.onComplete();
            return fullText;
        }

        for await (const chunk of body as any) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (!data) continue;
                if (data === '[DONE]') {
                    sink?.onComplete();
                    return fullText;
                }
                try {
                    const payload = JSON.parse(data);
                    
                    // [Capture] generation_id and model from the stream
                    if (traceContext) {
                        if (payload.id && !traceContext.generation_id) {
                            traceContext.generation_id = payload.id;
                        }
                        if (payload.model && !traceContext.model_from_stream) {
                            traceContext.model_from_stream = payload.model;
                        }
                    }

                    const delta = payload?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        fullText += delta;
                        sink?.onDelta(delta);
                    }
                } catch (e) {
                    logger.warn({ kind: 'sys', component: COMPONENT, message: 'Failed to parse stream chunk', error: e });
                }
            }
        }

        if (buffer.trim().length > 0 && buffer.trim().startsWith('data:')) {
            const data = buffer.trim().slice(5).trim();
            if (data && data !== '[DONE]') {
                try {
                    const payload = JSON.parse(data);
                    const delta = payload?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        fullText += delta;
                        sink?.onDelta(delta);
                    }
                } catch (e) {
                    logger.warn({ kind: 'sys', component: COMPONENT, message: 'Failed to parse stream tail', error: e });
                }
            }
        }

        sink?.onComplete();
        return fullText;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        sink?.onError(err);
        throw err;
    }
};

const buildChatCompletionResponse = (content: string, model?: string) => ({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [
        {
            index: 0,
            message: {
                role: 'assistant',
                content
            },
            finish_reason: 'stop'
        }
    ]
});
