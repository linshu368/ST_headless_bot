/**
 * GPT API 调用封装
 * 用于 Git 运维工具的 AI 能力调用
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载 .env 文件
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface GptCallerOptions {
    model?: string;
    timeout?: number;
}

export class GptCaller {
    private apiKey: string;
    private apiUrl: string;
    private model: string;
    private timeout: number;

    constructor(options: GptCallerOptions = {}) {
        this.apiKey = process.env.OPENAI_API_KEY || '';
        this.apiUrl = process.env.OPENAI_API_URL || '';
        // 运维工具使用配置的模型，优先级: OPS_GPT_MODEL > OPENAI_MODEL > 默认值
        this.model = options.model || process.env.OPENAI_MODEL || 'anthropic/claude-opus-4.5';
        this.timeout = options.timeout || 60000;

        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY 未找到！请检查 .env 文件');
        }
    }

    /**
     * 发送 prompt 并获取 GPT 响应
     */
    async getResponse(prompt: string): Promise<string> {
        const headers = {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };

        const data = {
            model: this.model,
            messages: [
                { role: 'user', content: prompt }
            ]
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API 请求失败，状态码: ${response.status}, 错误: ${errText}`);
            }

            const result = await response.json() as any;
            return result.choices?.[0]?.message?.content || '';
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`请求超时，超过 ${this.timeout / 1000} 秒`);
            }
            throw new Error(`GPT 调用失败: ${error.message}`);
        }
    }
}

// 默认导出一个工厂函数
export const createGptCaller = (options?: GptCallerOptions) => new GptCaller(options);
