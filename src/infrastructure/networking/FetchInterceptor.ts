import fs from 'fs';
import path from 'path';
import fetch, { Response } from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import globalConfig from '../../platform/config.js';

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
            console.log('[Network] Hijacked Ping. Returning 200 OK.');
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
             console.log(`[Network] Hijacked /api/characters/all. Returning ${mockState.characters.length} characters.`);
             return {
                 ok: true,
                 status: 200,
                 headers: { get: () => null },
                 json: async () => mockState.characters
             };
        }
        
        // 3. Intercept Chat Fetch
        if (normalizedUrl === '/api/chats/get') {
             console.log(`[Network] Hijacked /api/chats/get. Returning ${mockState.chats.length} chats.`);
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
            console.log('[Network] Hijacked /api/chats/save. Success.');
            // Ideally we should update mockState.chats here if we want persistence simulation
            return {
                ok: true,
                status: 200,
                json: async () => ({})
            };
        }
    
        // 3.3 Intercept Chat Generation (Proxy to Real LLM)
        if (normalizedUrl === '/api/backends/chat-completions/generate') {
            console.log('[Network] Hijacked Chat Generation Request.');
            try {
                // Determine Configuration (Env vars take precedence over ST config)
                // Use globalConfig for sensitive credentials
                const apiKey = globalConfig.openai.apiKey || config.api_key_openai;
                const apiUrl = globalConfig.openai.apiUrl || config.api_url_openai || 'https://api.openai.com/v1';
                const model = globalConfig.openai.model || config.openai_model;

                const baseUrl = apiUrl.replace(/\/$/, '');
                const targetUrl = baseUrl.endsWith('/chat/completions')
                    ? baseUrl
                    : `${baseUrl}/chat/completions`;
                
                console.log(`[Network] Forwarding to LLM: ${targetUrl}`);
                
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
                    console.error('[Network] Failed to parse body', e);
                }

                const bodyKeys = requestBody ? Object.keys(requestBody) : [];
                const messageCount = Array.isArray(requestBody?.messages) ? requestBody.messages.length : 0;
                console.log(`[Network] Request body keys: ${bodyKeys.join(', ') || '(empty)'}`);
                console.log(`[Network] messages length: ${messageCount}`);
                

                // [DEBUG] Print the first message (System Prompt) to check character injection
                if (requestBody.messages && requestBody.messages.length > 0) {
                    console.log('[Network] First Message (System Prompt/Role):');
                    console.log(JSON.stringify(requestBody.messages[0], null, 2));
                    
                    // Also print the last message to see user input
                    if (requestBody.messages.length > 1) {
                        console.log('[Network] Last Message (User Input):');
                        console.log(JSON.stringify(requestBody.messages[requestBody.messages.length - 1], null, 2));
                    }
               }
               
                // Force override model
                if (model) {
                     console.log(`[Network] Overriding model: ${requestBody.model} -> ${model}`);
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
    
                if (streamModeEnabled) {
                    requestBody.stream = true;
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
                    console.error('[Network] LLM Error:', errText);
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
                    const fullText = await parseOpenAIStream(response, streamSink);
                    const responseBody = buildChatCompletionResponse(fullText, requestBody.model || model);
                    return new Response(JSON.stringify(responseBody), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // Return the real response stream directly
                return response;
    
            } catch (err: any) {
                console.error('[Network] Chat Generation Proxy Failed:', err);
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
            console.log('[Network] Hijacked Chat Status. Returning connected.');
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
            // console.log(`[Network] Static File Request: ${url}`);
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
                     // console.warn(`[Network] Static File Not Found: ${filePath}`);
                     return {
                         ok: false,
                         status: 404,
                         headers: { get: () => null },
                         text: async () => 'Not Found',
                         json: async () => ({}),
                     };
                }
            } catch (fileErr) {
                console.error(`[Network] Static File Error:`, fileErr);
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
            console.error('[Network] Request Failed:', error);
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

    return interceptor;
};

const parseOpenAIStream = async (response: Response, sink: StreamSink | null): Promise<string> => {
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
                    const delta = payload?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        fullText += delta;
                        sink?.onDelta(delta);
                    }
                } catch (e) {
                    console.warn('[Network] Failed to parse stream chunk', e);
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
                    console.warn('[Network] Failed to parse stream tail', e);
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

