import type { IChannelRegistry } from '../../features/chat/ports/IChannelRegistry.js';
import type { IAIChannel } from '../../features/chat/ports/IAIChannel.js';
import { PipelineChannel } from './channels/PipelineChannel.js';
import type { AIProfileConfig } from '../../types/config.js';
import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';

export class ChannelRegistry implements IChannelRegistry {
    private channels: Map<string, IAIChannel> = new Map();

    constructor() {
        this.initializeChannels();
    }

    private initializeChannels() {
        try {
            // 从 Config Source (将来是 Supabase) 加载配置
            const channels = config.ai_config_source.channels;

            // 动态组装 PipelineChannel
            for (const [channelId, steps] of Object.entries(channels)) {
                // 1. 验证数据完整性 (简单的运行时检查)
                if (!Array.isArray(steps) || steps.length === 0) {
                    logger.warn({ kind: 'infra', component: 'ChannelRegistry', message: `Skipping empty channel: ${channelId}` });
                    continue;
                }

                // 2. 直接实例化 PipelineChannel
                this.channels.set(channelId, new PipelineChannel(channelId, steps));
                logger.info({ kind: 'infra', component: 'ChannelRegistry', message: `Registered channel: ${channelId} with ${steps.length} steps` });
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: 'ChannelRegistry', message: 'Failed to initialize channels', error });
        }
    }

    getChannel(channelId: string): IAIChannel | undefined {
        return this.channels.get(channelId);
    }
}
