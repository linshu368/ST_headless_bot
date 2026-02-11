import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ProxyAgent } from 'proxy-agent';
import nodeFetch from 'node-fetch';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseClient';

class SupabaseService {
    private static instance: SupabaseService;
    public client: SupabaseClient | null = null;

    private constructor() {
        if (config.supabase.url && config.supabase.key) {
            try {
                const options: Record<string, any> = {};

                // 如果配置了代理，为 Supabase 创建代理感知的 fetch
                if (config.telegram.proxy) {
                    const proxyUrl = `${config.telegram.proxy.scheme}://${config.telegram.proxy.host}:${config.telegram.proxy.port}`;
                    const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
                    options.global = {
                        fetch: ((url: any, init: any) => {
                            return nodeFetch(url, { ...init, agent }) as any;
                        })
                    };
                    logger.info({ kind: 'sys', component: COMPONENT, message: `Using proxy for Supabase: ${proxyUrl}` });
                }

                this.client = createClient(config.supabase.url, config.supabase.key, options);
                logger.info({ kind: 'sys', component: COMPONENT, message: 'Supabase client initialized' });
            } catch (error) {
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to initialize Supabase client', error });
            }
        } else {
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'Supabase credentials missing' });
        }
    }

    public static getInstance(): SupabaseService {
        if (!SupabaseService.instance) {
            SupabaseService.instance = new SupabaseService();
        }
        return SupabaseService.instance;
    }
}

export const supabase = SupabaseService.getInstance().client;
