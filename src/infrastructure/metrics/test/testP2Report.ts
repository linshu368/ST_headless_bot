/**
 * 用真实 Redis 数据手动触发一次 P2 报表。
 *
 * 运行：npx tsx scripts/testP2Report.ts
 */

// dotenv 需要先加载，确保 Redis 和 Webhook 配置可用
import 'dotenv/config';
import { p2Report } from '../P2ReportService.js';

console.log('📤 Triggering P2 report with real Redis data...');

try {
    await p2Report.generateAndSend(6);
    console.log('✅ 报表发送完成，去飞书群查看。');
} catch (err) {
    console.error('❌ 失败:', err);
    process.exit(1);
}