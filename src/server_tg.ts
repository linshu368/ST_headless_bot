import config from './platform/config.js';
import { TelegramBotAdapter } from './features/telegram_adapter/TelegramBotAdapter.js';
import { setupGlobalErrorHandlers } from './infrastructure/globalErrorHandler.js';
import { feishuAlert, AlertType } from './infrastructure/alerts/FeishuAlertService.js';
import { p2Report } from './infrastructure/metrics/P2ReportService.js';
import { logger } from './platform/logger.js';
import { createServer } from 'node:http';

// 初始化全局崩溃告警
setupGlobalErrorHandlers();

async function main() {
    console.log('=== SillyTavern Telegram Bot Service ===');
    
    if (!config.telegram.token) {
        logger.error({ kind: 'sys', component: 'Main', message: 'TELEGRAM_BOT_TOKEN is not set' });
        await feishuAlert.sendP0Critical({
            alertType: AlertType.BOOT_MISSING_TOKEN,
            message: 'TELEGRAM_BOT_TOKEN 环境变量未配置，Bot 服务无法启动。需要检查 Railway 环境变量配置。',
        });
        process.exit(1);
    }

    const adapter = new TelegramBotAdapter(config.telegram.token);

    try {
        await adapter.start();
        p2Report.startSchedule();
        console.log('Bot is running. Press Ctrl+C to stop.');

        const healthPort = Number(process.env.PORT) || 3000;
        const healthServer = createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/health') {
                const body = JSON.stringify({ status: 'ok', uptime: process.uptime() });
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                });
                res.end(body);
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        });

        healthServer.listen(healthPort, () => {
            console.log(`Health check server listening on port ${healthPort}`);
        });
        
        // Keep process alive
        process.on('SIGINT', async () => {
            console.log('\nStopping bot...');
            p2Report.stopSchedule();
            await new Promise<void>((resolve) => healthServer.close(() => resolve()));
            await adapter.stop();
            process.exit(0);
        });

    } catch (error) {
        logger.error({ kind: 'sys', component: 'Main', message: 'Failed to start bot', error });
        await feishuAlert.sendP0Critical({
            alertType: AlertType.BOOT_INIT_FAILURE,
            message: 'adapter.start() 或 health server 启动过程中抛出异常，Bot 服务无法启动。',
            error,
        });
        process.exit(1);
    }
}

main();