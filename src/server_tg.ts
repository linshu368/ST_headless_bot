import config from './platform/config.js';
import { TelegramBotAdapter } from './features/telegram_adapter/TelegramBotAdapter.js';

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
        
        // Keep process alive
        process.on('SIGINT', async () => {
            console.log('\nStopping bot...');
            await adapter.stop();
            process.exit(0);
        });

    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

main();

