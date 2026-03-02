/**
 * Ops 专用 runtime_config 读取器
 *
 * 直连 Supabase PostgREST，不走 Redis，不依赖应用基础设施。
 * 失败时静默回退到调用方提供的 fallback，绝不阻塞 git hook 主流程。
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProxyAgent } from 'proxy-agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const QUERY_TIMEOUT_MS = 5_000;

const LOG_PREFIX = '[OpsConfig]';

function createProxyAgent(): InstanceType<typeof ProxyAgent> | undefined {
    const scheme = (process.env.TELEGRAM_PROXY_SCHEME || '').trim();
    const host = (process.env.TELEGRAM_PROXY_HOST || '').trim();
    const port = (process.env.TELEGRAM_PROXY_PORT || '').trim();
    if (!scheme || !host || !port) return undefined;

    const normalized = scheme.toLowerCase() === 'socks5' ? 'socks5h' : scheme.toLowerCase();
    return new ProxyAgent({ getProxyForUrl: () => `${normalized}://${host}:${port}` });
}

let cachedAgent: InstanceType<typeof ProxyAgent> | undefined | null = null;
function getAgent() {
    if (cachedAgent === null) cachedAgent = createProxyAgent();
    return cachedAgent;
}

/**
 * 从 Supabase runtime_config 表直读 text_value。
 * 任何异常均静默回退 fallback。
 */
export async function readOpsConfig(key: string, fallback: string): Promise<string> {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error(`${LOG_PREFIX} Supabase credentials missing, fallback for: ${key}`);
        return fallback;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

    try {
        const url = `${SUPABASE_URL}/rest/v1/runtime_config`
            + `?key=eq.${encodeURIComponent(key)}`
            + `&select=text_value`;

        const agent = getAgent();
        const res = await fetch(url, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: controller.signal as any,
            ...(agent ? { agent } : {}),
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const rows = (await res.json()) as Array<{ text_value: string | null }>;
        if (rows.length > 0 && typeof rows[0].text_value === 'string' && rows[0].text_value.length > 0) {
            console.error(`${LOG_PREFIX} loaded ${key} from Supabase (${rows[0].text_value.length} chars)`);
            return rows[0].text_value;
        }

        console.error(`${LOG_PREFIX} empty result for ${key}, using fallback`);
        return fallback;
    } catch (err: any) {
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        console.error(`${LOG_PREFIX} ${key} failed (${reason}), using fallback`);
        return fallback;
    } finally {
        clearTimeout(timer);
    }
}
