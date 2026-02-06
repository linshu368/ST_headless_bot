import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';

const COMPONENT = 'SupabaseClient';

class SupabaseService {
    private static instance: SupabaseService;
    public client: SupabaseClient | null = null;

    private constructor() {
        if (config.supabase.url && config.supabase.key) {
            try {
                this.client = createClient(config.supabase.url, config.supabase.key);
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
