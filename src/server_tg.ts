import config from './platform/config.js';
import { TelegramBotAdapter } from './features/telegram_adapter/TelegramBotAdapter.js';
import { setupGlobalErrorHandlers } from './infrastructure/globalErrorHandler.js';
import { createServer } from 'node:http';

// 初始化全局崩溃告警
setupGlobalErrorHandlers();

async function main() {
    console.log('=== SillyTavern Telegram Bot Service ===');
    
    if (!config.telegram.token) {
        console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env');
        process.exit(1);
    }

    const adapter = new TelegramBotAdapter(config.telegram.token);

    try {
        await adapter.start();
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
            await new Promise<void>((resolve) => healthServer.close(() => resolve()));
            await adapter.stop();
            process.exit(0);
        });

    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

main();

