import fetch, { type Response } from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import dotenv from 'dotenv';

dotenv.config();

type OpenRouterStatsResponse = {
    data?: {
        model?: string;
        generation_time?: number;
        latency?: number;
        native_tokens_prompt?: number;
        native_tokens_completion?: number;
        native_tokens_reasoning?: number;
        native_tokens_cached?: number;
        cache_discount?: number;
        usage?: unknown;
        finish_reason?: string;
        provider_name?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

const parseArgs = (argv: string[]) => {
    const prompts: string[] = [];
    let model = process.env.OPENROUTER_MODEL || '';
    let apiUrl = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1';
    let apiKey = process.env.OPENROUTER_API_KEY || '';
    let stream = process.env.STREAM === '1';

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--prompt':
                if (argv[i + 1]) {
                    prompts.push(argv[i + 1]);
                    i += 1;
                }
                break;
            case '--model':
                if (argv[i + 1]) {
                    model = argv[i + 1];
                    i += 1;
                }
                break;
            case '--url':
                if (argv[i + 1]) {
                    apiUrl = argv[i + 1];
                    i += 1;
                }
                break;
            case '--key':
                if (argv[i + 1]) {
                    apiKey = argv[i + 1];
                    i += 1;
                }
                break;
            case '--stream':
                stream = true;
                break;
            default:
                prompts.push(arg);
                break;
        }
    }

    if (prompts.length === 0) {
        prompts.push(process.env.PROMPT || 'Hello from OpenRouter trace');
    }

    return { prompts, model, apiUrl, apiKey, stream };
};

const readStreamForId = async (response: Response): Promise<string | null> => {
    const decoder = new TextDecoder('utf-8');
    const body = response.body;
    if (!body) return null;

    let buffer = '';
    let generationId: string | null = null;

    for await (const chunk of body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const payload = JSON.parse(data);
                if (payload?.id && !generationId) {
                    generationId = String(payload.id);
                }
            } catch {
                // ignore parse errors in stream chunks
            }
        }

        if (generationId) {
            // We already got the id; no need to keep reading
            break;
        }
    }

    return generationId;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchStatsFromUrl = async (
    statsUrl: string,
    apiKey: string,
    maxAttempts: number,
    retryDelayMs: number,
    agent?: ProxyAgent
) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const statsResponse = await fetch(statsUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            agent
        });

        if (statsResponse.ok) {
            const statsJson = (await statsResponse.json()) as OpenRouterStatsResponse;
            return { statsUrl, statsJson };
        }

        const errText = await statsResponse.text();
        if (statsResponse.status === 404 && attempt < maxAttempts) {
            console.warn(`Stats not ready yet (404). Retry ${attempt}/${maxAttempts}...`);
            await sleep(retryDelayMs);
            continue;
        }

        throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText} ${errText}`);
    }

    throw new Error('Stats fetch failed: exceeded retries');
};

const fetchStats = async (apiUrl: string, apiKey: string, generationId: string, agent?: ProxyAgent) => {
    const baseUrl = apiUrl.replace(/\/$/, '');
    const maxAttempts = 6;
    const retryDelayMs = 1500;

    // Use legacy endpoint only: /generation?id={id}
    const legacyStatsUrl = `${baseUrl}/generation?id=${encodeURIComponent(generationId)}`;
    return await fetchStatsFromUrl(legacyStatsUrl, apiKey, maxAttempts, retryDelayMs, agent);
};

const buildProxyUrl = (): string | null => {
    const scheme = process.env.TELEGRAM_PROXY_SCHEME;
    const host = process.env.TELEGRAM_PROXY_HOST;
    const port = process.env.TELEGRAM_PROXY_PORT;

    if (!scheme || !host || !port) return null;
    return `${scheme}://${host}:${port}`;
};

const run = async () => {
    const { prompts, model, apiUrl, apiKey, stream } = parseArgs(process.argv.slice(2));
    const proxyUrl = buildProxyUrl();
    const agent = proxyUrl ? new ProxyAgent(proxyUrl as any) : undefined;

    if (!apiKey) {
        throw new Error('Missing OPENROUTER_API_KEY (or pass --key)');
    }
    if (!model) {
        throw new Error('Missing OPENROUTER_MODEL (or pass --model)');
    }

    const baseUrl = apiUrl.replace(/\/$/, '');
    const chatUrl = `${baseUrl}/chat/completions`;

    for (const prompt of prompts) {
        console.log('---');
        console.log(`api_url: ${chatUrl}`);
        console.log(`api_key: ${apiKey}`);

        const body = {
            model,
            stream,
            messages: [
                { role: 'user', content: prompt }
            ]
        };

        const response = await fetch(chatUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            agent,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Chat completion failed: ${response.status} ${response.statusText} ${errText}`);
        }

        let generationId: string | null = null;

        if (stream) {
            generationId = await readStreamForId(response);
        } else {
            const json = (await response.json()) as any;
            generationId = json?.id ? String(json.id) : null;
        }

        if (!generationId) {
            throw new Error('generation_id not found in response');
        }

        console.log(`generation_id: ${generationId}`);

        const { statsUrl, statsJson } = await fetchStats(baseUrl, apiKey, generationId, agent);
        console.log(`stats_url: ${statsUrl}`);
        console.log('metadata:');
        console.log(JSON.stringify(statsJson, null, 2));
    }
};

run().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
