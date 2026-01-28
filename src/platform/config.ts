import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
    telegram: {
        token: string;
        proxy: {
            scheme: string;
            host: string;
            port: number;
        } | null;
    };
    openai: {
        apiKey: string;
        apiUrl: string;
        model: string;
    };
    st: {
        mockDataPath: string;
    };
}

const config: Config = {
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN || '',
        proxy: process.env.TELEGRAM_PROXY_SCHEME
            && process.env.TELEGRAM_PROXY_HOST
            && process.env.TELEGRAM_PROXY_PORT
            ? {
                scheme: process.env.TELEGRAM_PROXY_SCHEME,
                host: process.env.TELEGRAM_PROXY_HOST,
                port: Number(process.env.TELEGRAM_PROXY_PORT),
            }
            : null,
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        apiUrl: process.env.OPENAI_API_URL || 'https://aifuturekey.xyz/v1/chat/completions',
        model: process.env.OPENAI_MODEL || 'grok-4-fast-non-reasoning',
    },
    st: {
        mockDataPath: path.resolve(process.cwd(), 'src/infrastructure/mock_data'),
    }
};

export default config;
