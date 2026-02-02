import type { IChannelRegistry } from '../../features/chat/ports/IChannelRegistry.js';
import type { IAIChannel } from '../../features/chat/ports/IAIChannel.js';
import { PipelineChannel, type AIProfileConfig } from './channels/PipelineChannel.js';
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
            const { profiles, pipelines } = config.ai_config_source;

            // 动态组装 PipelineChannel
            for (const [pipelineId, stepIds] of Object.entries(pipelines)) {
                // 解析原子 Profile，过滤无效 ID
                const steps: AIProfileConfig[] = stepIds
                    .map(id => profiles[id])
                    .filter(Boolean);

                if (steps.length > 0) {
                    this.channels.set(pipelineId, new PipelineChannel(pipelineId, steps));
                    logger.info({ kind: 'infra', component: 'ChannelRegistry', message: `Registered pipeline: ${pipelineId} with ${steps.length} steps` });
                } else {
                    logger.warn({ kind: 'infra', component: 'ChannelRegistry', message: `Skipping empty pipeline: ${pipelineId}` });
                }
            }
        } catch (error) {
            logger.error({ kind: 'infra', component: 'ChannelRegistry', message: 'Failed to initialize channels', error });
        }
    }

    getChannel(channelId: string): IAIChannel | undefined {
        return this.channels.get(channelId);
    }
}
