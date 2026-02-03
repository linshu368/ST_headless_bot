import assert from 'node:assert/strict';
import { resolveChannelId, ModelTier } from '../ModelStrategy.js';

const testGoldenTierMapping = () => {
    // Golden Test: 锁死业务策略映射关系
    // 如果产品经理没有明确要求修改策略，这个测试不应该变
    assert.equal(resolveChannelId(ModelTier.BASIC), 'channel_1');
    assert.equal(resolveChannelId(ModelTier.STANDARD_A), 'channel_2');
    assert.equal(resolveChannelId(ModelTier.STANDARD_B), 'channel_3');
};

const run = () => {
    testGoldenTierMapping();
    console.log('ModelStrategy.test: OK');
};

run();
