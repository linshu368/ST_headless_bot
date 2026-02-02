import type { IAIChannel } from './IAIChannel.js';

/**
 * Layer C: Port - 通道注册表接口
 */
export interface IChannelRegistry {
    /**
     * 根据 ID 获取通道实例
     * @param channelId 通道 ID (e.g. "channel_1")
     */
    getChannel(channelId: string): IAIChannel | undefined;
}
