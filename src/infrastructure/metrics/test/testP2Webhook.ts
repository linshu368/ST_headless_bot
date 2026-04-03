/**
 * 手动发送一份带模拟数据的 P2 报表卡片到飞书，
 * 纯粹验证：签名算法、Webhook 连通性、卡片渲染效果。
 * 不依赖 Redis 有数据。
 *
 * 运行：npx tsx scripts/testP2Webhook.ts
 */

import crypto from 'crypto';
import { computeReport, buildCard, type RawMetrics } from '../p2ReportLogic.js';

// ========== 配置 ==========
const WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/925c6e91-75ff-47b9-b962-afd1bb8517f0';
const WEBHOOK_SECRET = 'vzv6L1NWGcSlJfAxpLKVDb';

// ========== 构造一份逼真的模拟数据 ==========
const mockRaw: RawMetrics = {
    totalRequests: 1234,
    firstChunkGt8s: 47,
    totalDurationGt25s: 23,
    step2Success: 89,
    step3Success: 12,
    noDeduction: 18,
    allStepsFailed: 5,
    modelTotalCalls: new Map([
        ['grok-3', 680],
        ['claude-sonnet-4', 420],
        ['gpt-4o', 250],
    ]),
    modelFirstchunkTimeout: new Map([
        ['grok-3', 8],
        ['claude-sonnet-4', 3],
        ['gpt-4o', 1],
    ]),
    modelEmptyStream: new Map([
        ['grok-3', 2],
        ['claude-sonnet-4', 1],
    ]),
    modelApiError: new Map([
        ['grok-3', 2],
        ['claude-sonnet-4', 1],
    ]),
    modelNetworkError: new Map([
        ['grok-3', 1],
    ]),
    modelStrategyTruncated: new Map([
        ['grok-3', 2],
        ['claude-sonnet-4', 1],
    ]),
    modelProviderTruncated: new Map([
        ['grok-3', 1],
    ]),
};

// ========== 生成报表数据 + 卡片 ==========
const reportData = computeReport(mockRaw, 6, new Date());
const card = buildCard(reportData) as any;

// ========== 签名 ==========
const timestamp = Math.floor(Date.now() / 1000).toString();
const signStr = `${timestamp}\n${WEBHOOK_SECRET}`;
const signature = crypto.createHmac('sha256', signStr).update('').digest('base64');

card.timestamp = timestamp;
card.sign = signature;

// ========== 发送 ==========
console.log('📤 Sending test P2 report to Feishu...');
console.log('   Card preview (partial):', JSON.stringify(card, null, 2).slice(0, 500), '...\n');

const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
});

const body = await response.text();
console.log(`📬 Response: ${response.status} ${response.statusText}`);
console.log(`   Body: ${body}`);

if (response.ok && body.includes('"StatusCode":0')) {
    console.log('\n✅ 成功！去飞书群里看看卡片渲染效果吧。');
} else {
    console.log('\n❌ 发送失败，检查上面的错误信息。');
    process.exit(1);
}