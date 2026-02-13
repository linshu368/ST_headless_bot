import type { IChannelRegistry } from '../../features/chat/ports/IChannelRegistry.js';
import type { IAIChannel } from '../../features/chat/ports/IAIChannel.js';
import { PipelineChannel } from './channels/PipelineChannel.js';
import { logger } from '../../platform/logger.js';
import { runtimeConfig } from '../runtime_config/RuntimeConfigService.js';

export class ChannelRegistry implements IChannelRegistry {

    /**
     * 根据 channelId 动态创建通道实例
     * 每次调用都从 RuntimeConfigService 获取最新配置（内存缓存命中时 0ms 开销）
     */
    async getChannel(channelId: string): Promise<IAIChannel | undefined> {
        try {
            const configSource = await runtimeConfig.getAIConfigSource();
            const steps = configSource.channels[channelId];

            if (!Array.isArray(steps) || steps.length === 0) {
                logger.warn({ kind: 'infra', component: 'ChannelRegistry', message: `Channel not found or empty: ${channelId}` });
                return undefined;
            }

            return new PipelineChannel(channelId, steps);
        } catch (error) {
            logger.error({ kind: 'infra', component: 'ChannelRegistry', message: 'Failed to get channel', error });
            return undefined;
        }
    }
}
