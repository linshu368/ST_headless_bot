import assert from 'node:assert/strict';
import { resolveChannelId, mapLegacyModeToTier, ModelTier } from '../ModelStrategy.js';

const testGoldenTierMapping = () => {
    // Golden Test: 锁死业务策略映射关系
    // 如果产品经理没有明确要求修改策略，这个测试不应该变
    assert.equal(resolveChannelId(ModelTier.BASIC), 'channel_1');
    assert.equal(resolveChannelId(ModelTier.STANDARD), 'channel_2');
    assert.equal(resolveChannelId(ModelTier.PREMIUM), 'channel_3');
};

const testLegacyModeMapping = () => {
    assert.equal(mapLegacyModeToTier('fast'), ModelTier.BASIC);
    assert.equal(mapLegacyModeToTier('story'), ModelTier.STANDARD);
    assert.equal(mapLegacyModeToTier('immersive'), ModelTier.PREMIUM);
    
    // Edge cases
    assert.equal(mapLegacyModeToTier('FAST'), ModelTier.BASIC); // case insensitive
    assert.equal(mapLegacyModeToTier(' unknown '), ModelTier.PREMIUM); // fallback
    assert.equal(mapLegacyModeToTier(''), ModelTier.PREMIUM); // empty fallback
};

const run = () => {
    testGoldenTierMapping();
    testLegacyModeMapping();
    console.log('ModelStrategy.test: OK');
};

run();
