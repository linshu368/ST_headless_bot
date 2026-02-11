import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';
import type { OpenAIMessage } from '../../features/session/usecases/SessionManager.js';

const COMPONENT = 'SupabaseSnapshotRepository';

export interface ChatSnapshot {
    id: string;
    user_id: string;
    role_id: string;
    snapshot_name: string;
    history: OpenAIMessage[];
    created_at: string;
}

export class SupabaseSnapshotRepository {
    
    async createSnapshot(userId: string, roleId: string, snapshotName: string, messages: OpenAIMessage[]): Promise<string | null> {
        if (!supabase) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Supabase client not initialized' });
            return null;
        }

        try {
            const { data, error } = await supabase
                .from('chat_snapshots')
                .insert({
                    user_id: userId,
                    role_id: roleId,
                    snapshot_name: snapshotName,
                    history: messages
                })
                .select('id')
                .single();

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: `Failed to create snapshot: ${error.message} (code: ${error.code})`, meta: { hint: error.hint, details: error.details } });
                return null;
            }

            logger.info({ kind: 'infra', component: COMPONENT, message: 'Snapshot created', meta: { id: data.id, snapshotName } });
            return data.id;

        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception creating snapshot', error });
            return null;
        }
    }

    async getSnapshots(userId: string): Promise<ChatSnapshot[]> {
        if (!supabase) return [];

        try {
            const { data, error } = await supabase
                .from('chat_snapshots')
                .select('id, user_id, role_id, snapshot_name, created_at') // Don't fetch full messages for list
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: `Failed to list snapshots: ${error.message} (code: ${error.code})`, meta: { hint: error.hint, details: error.details } });
                return [];
            }

            return data as ChatSnapshot[];

        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception listing snapshots', error });
            return [];
        }
    }

    async getSnapshot(snapshotId: string): Promise<ChatSnapshot | null> {
        if (!supabase) return null;

        try {
            const { data, error } = await supabase
                .from('chat_snapshots')
                .select('*')
                .eq('id', snapshotId)
                .single();

            if (error) {
                logger.warn({ kind: 'infra', component: COMPONENT, message: `Failed to get snapshot: ${error.message} (code: ${error.code})`, meta: { hint: error.hint, details: error.details } });
                return null;
            }

            return data as ChatSnapshot;

        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception getting snapshot', error });
            return null;
        }
    }

    async deleteSnapshot(snapshotId: string): Promise<boolean> {
        if (!supabase) return false;

        try {
            const { error } = await supabase
                .from('chat_snapshots')
                .delete()
                .eq('id', snapshotId);

            if (error) {
                logger.error({ kind: 'infra', component: COMPONENT, message: `Failed to delete snapshot: ${error.message} (code: ${error.code})`, meta: { hint: error.hint, details: error.details } });
                return false;
            }

            return true;

        } catch (error) {
            logger.error({ kind: 'infra', component: COMPONENT, message: 'Exception deleting snapshot', error });
            return false;
        }
    }
}
