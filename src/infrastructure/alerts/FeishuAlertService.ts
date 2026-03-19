import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import crypto from 'crypto';

const COMPONENT = 'FeishuAlertService';

export type AlertLevel = 'P0' | 'P1';

export interface AlertContext {
    title: string;
    message: string;
    error?: Error | unknown;
    traceId?: string;
    userId?: string;
    userInput?: string;
    meta?: Record<string, any>;
}

interface AlertRecord {
    count: number;
    firstSeen: number;
    lastSeen: number;
}

class FeishuAlertService {
    private static instance: FeishuAlertService;
    private webhookUrl: string;
    private webhookSecret: string;
    
    // 防抖记录器：key -> AlertRecord
    private alertRecords: Map<string, AlertRecord> = new Map();
    
    // 防抖时间配置
    private readonly DEBOUNCE_MS_P0 = 3 * 60 * 1000;  // P0: 3分钟
    private readonly DEBOUNCE_MS_P1 = 10 * 60 * 1000; // P1: 10分钟

    private constructor() {
        this.webhookUrl = config.alerts.feishuWebhookUrl;
        this.webhookSecret = config.alerts.feishuWebhookSecret;
        if (!this.webhookUrl) {
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'Feishu Webhook URL is not configured. Alerts will be disabled.' });
        }
    }

    static getInstance(): FeishuAlertService {
        if (!FeishuAlertService.instance) {
            FeishuAlertService.instance = new FeishuAlertService();
        }
        return FeishuAlertService.instance;
    }

    /**
     * 异步发送 P0 崩溃级告警
     * 响应要求：放下手里任何事情立刻处理。
     */
    async sendP0(context: AlertContext): Promise<void> {
        // Fire and forget, 不阻塞主线程
        this.processAlert('P0', context).catch(err => {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to process P0 alert', error: err });
        });
    }

    /**
     * 异步发送 P1 严重级告警
     * 响应要求：工作时间内2小时内处理，不需要半夜叫人。
     */
    async sendP1(context: AlertContext): Promise<void> {
        // Fire and forget, 不阻塞主线程
        this.processAlert('P1', context).catch(err => {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to process P1 alert', error: err });
        });
    }

    private async processAlert(level: AlertLevel, context: AlertContext): Promise<void> {
        if (!this.webhookUrl) return;

        const signature = `${level}:${context.title}`;
        const now = Date.now();
        const debounceMs = level === 'P0' ? this.DEBOUNCE_MS_P0 : this.DEBOUNCE_MS_P1;

        let record = this.alertRecords.get(signature);
        
        if (record) {
            record.count += 1;
            record.lastSeen = now;
            
            // 如果在防抖窗口内，只累加次数，不发送
            if (now - record.firstSeen < debounceMs) {
                logger.debug({ kind: 'sys', component: COMPONENT, message: `Alert debounced (suppressed): ${signature}, count: ${record.count}` });
                return;
            }
            
            // 超过防抖窗口，准备发送聚合信息，并重置窗口
            context.meta = {
                ...context.meta,
                _aggregated_info: `⚠️ 过去 ${Math.round(debounceMs / 60000)} 分钟内，同类报错共发生 ${record.count} 次`
            };
            
            // 重置记录
            record.count = 1;
            record.firstSeen = now;
            record.lastSeen = now;
        } else {
            // 第一次出现
            this.alertRecords.set(signature, {
                count: 1,
                firstSeen: now,
                lastSeen: now
            });
        }

        await this.dispatchToFeishu(level, context);
    }

    private async dispatchToFeishu(level: AlertLevel, context: AlertContext): Promise<void> {
        const isP0 = level === 'P0';
        const headerColor = isP0 ? 'red' : 'orange';
        const headerTitle = isP0 ? `🚨 线上服务报警：${context.title}` : `🟠 P1 严重报警：${context.title}`;

        // 格式化时间
        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        // 提取错误摘要
        let errorSummary = '未知错误';
        let errorStack = '';
        if (context.error) {
            if (context.error instanceof Error) {
                errorSummary = `${context.error.name}: ${context.error.message}`;
                errorStack = context.error.stack || '';
            } else {
                errorSummary = String(context.error);
                errorStack = String(context.error);
            }
        }

        // 构建卡片内容 Markdown
        let contentMd = `**⏰ 发生时间:**\n${timeStr}\n`;
        
        if (context.traceId) {
            contentMd += `**🆔 TraceID (追踪号):**\n${context.traceId}\n`;
        }
        
        if (context.userId) {
            contentMd += `**👤 受影响用户:**\n${context.userId}\n`;
        }
        
        if (context.userInput) {
            // 截断过长的用户输入
            const inputPreview = context.userInput.length > 100 ? context.userInput.substring(0, 100) + '...' : context.userInput;
            contentMd += `**💬 用户当时发了什么:**\n"${inputPreview}"\n`;
        }
        
        contentMd += `**❌ 错误摘要:**\n${errorSummary}\n`;
        
        if (context.message) {
            contentMd += `*(补充说明: ${context.message})*\n`;
        }

        if (context.meta && context.meta._aggregated_info) {
            contentMd += `\n**📊 聚合统计:**\n${context.meta._aggregated_info}\n`;
        }

        const elements: any[] = [
            {
                tag: 'div',
                text: {
                    content: contentMd,
                    tag: 'lark_md'
                }
            }
        ];

        // 堆栈信息 (折叠面板)
        if (errorStack) {
            const stackPreview = errorStack.length > 500 ? errorStack.substring(0, 500) + '\n... (truncated)' : errorStack;
            
            // 飞书不支持原生的折叠面板，我们用 hr 分割线 + 明确的标题来模拟
            elements.push({
                tag: 'hr'
            });
            elements.push({
                tag: 'div',
                text: {
                    content: `**🛠 堆栈信息 (前500字):**\n\`\`\`text\n${stackPreview}\n\`\`\``,
                    tag: 'lark_md'
                }
            });
        }

        // 其他上下文信息
        const otherMeta = { ...context.meta };
        delete otherMeta._aggregated_info;
        if (Object.keys(otherMeta).length > 0) {
            elements.push({
                tag: 'hr'
            });
            elements.push({
                tag: 'div',
                text: {
                    content: `**📦 附加元数据:**\n\`\`\`json\n${JSON.stringify(otherMeta, null, 2)}\n\`\`\``,
                    tag: 'lark_md'
                }
            });
        }

        const payload: any = {
            msg_type: 'interactive',
            card: {
                config: {
                    wide_screen_mode: true,
                    enable_forward: true
                },
                header: {
                    title: {
                        content: headerTitle,
                        tag: 'plain_text'
                    },
                    template: headerColor
                },
                elements: elements
            }
        };

        // 飞书自定义机器人签名校验
        if (this.webhookSecret) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const signStr = `${timestamp}\n${this.webhookSecret}`;
            const signature = crypto.createHmac('sha256', signStr).update('').digest('base64');
            
            payload.timestamp = timestamp;
            payload.sign = signature;
        }

        try {
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to send Feishu alert', meta: { status: response.status, errText } });
            } else {
                logger.info({ kind: 'sys', component: COMPONENT, message: `Feishu ${level} alert sent`, meta: { title: context.title } });
            }
        } catch (error) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Exception while sending Feishu alert', error });
        }
    }
}

export const feishuAlert = FeishuAlertService.getInstance();
