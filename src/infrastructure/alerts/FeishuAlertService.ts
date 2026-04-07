import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import crypto from 'crypto';

const COMPONENT = 'FeishuAlertService';

export type AlertLevel = 'P0' | 'P1';

export enum AlertType {
    // P0 — 致命级
    UNCAUGHT_EXCEPTION      = 'UNCAUGHT_EXCEPTION',
    UNHANDLED_REJECTION     = 'UNHANDLED_REJECTION',
    BOOT_MISSING_TOKEN      = 'BOOT_MISSING_TOKEN',
    BOOT_INIT_FAILURE       = 'BOOT_INIT_FAILURE',
    REDIS_CONNECTION_LOST   = 'REDIS_CONNECTION_LOST',
    SUPABASE_CONNECTION_LOST = 'SUPABASE_CONNECTION_LOST',

    // P1 — 严重级
    CHANNEL_CONFIG_PARSE_ERROR = 'CHANNEL_CONFIG_PARSE_ERROR',
    HISTORY_SAVE_FAILURE    = 'HISTORY_SAVE_FAILURE',
    CREDIT_DEPOSIT_FAILURE  = 'CREDIT_DEPOSIT_FAILURE',

    // P1 — 降级观察（瞬态网络错误，尚未确认服务不可用）
    SUPABASE_DEGRADED       = 'SUPABASE_DEGRADED',
    REDIS_DEGRADED          = 'REDIS_DEGRADED',

    UNKNOWN                 = 'UNKNOWN',
}

const DEFAULT_TITLES: Record<AlertType, string> = {
    // P0
    [AlertType.UNCAUGHT_EXCEPTION]:       'Bot 进程致命崩溃 (Uncaught Exception)',
    [AlertType.UNHANDLED_REJECTION]:      'Bot 进程致命崩溃 (Unhandled Rejection)',
    [AlertType.BOOT_MISSING_TOKEN]:       'Bot 启动失败 — 缺少 TELEGRAM_BOT_TOKEN',
    [AlertType.BOOT_INIT_FAILURE]:        'Bot 启动失败 — 初始化异常',
    [AlertType.REDIS_CONNECTION_LOST]:    'Redis 连接完全断开',
    [AlertType.SUPABASE_CONNECTION_LOST]: 'Supabase 数据库连接完全断开',

    // P1
    [AlertType.CHANNEL_CONFIG_PARSE_ERROR]: '渠道/模型配置解析失败',
    [AlertType.HISTORY_SAVE_FAILURE]:       '用户历史记录保存或回滚失败',
    [AlertType.CREDIT_DEPOSIT_FAILURE]:     '充值成功但积分未到账',

    // P1 — 降级观察
    [AlertType.SUPABASE_DEGRADED]:  'Supabase 连接不稳定（瞬态网络错误，观察中）',
    [AlertType.REDIS_DEGRADED]:     'Redis 连接不稳定（瞬态网络错误，观察中）',

    [AlertType.UNKNOWN]:                    '未分类告警',
};

export interface AlertContext {
    alertType: AlertType;
    title?: string;
    message: string;
    error?: Error | unknown;
    traceId?: string;
    userId?: string;
    userInput?: string;
    meta?: Record<string, any>;
}

interface AlertRecord {
    level: AlertLevel;
    displayTitle: string;
    pendingCount: number;
    timer: ReturnType<typeof setTimeout> | null;
}

class FeishuAlertService {
    private static instance: FeishuAlertService;
    private webhookUrl: string;
    private webhookSecret: string;
    
    private alertRecords: Map<string, AlertRecord> = new Map();
    
    private readonly AGGREGATE_MS_P0 = 15 * 60 * 1000; // P0: 15分钟聚合周期
    private readonly AGGREGATE_MS_P1 = 20 * 60 * 1000; // P1: 20分钟聚合周期

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
     * 异步发送 P0 崩溃级告警（fire-and-forget，不阻塞调用方）
     */
    async sendP0(context: AlertContext): Promise<void> {
        this.processAlert('P0', context).catch(err => {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to process P0 alert', error: err });
        });
    }

    /**
     * 同步等待发送 P0 告警，用于进程即将退出的场景。
     * 绕过聚合逻辑，直接发送并等待 HTTP 响应返回。
     */
    async sendP0Critical(context: AlertContext): Promise<void> {
        if (!this.webhookUrl) return;
        await this.dispatchToFeishu('P0', { ...context, title: this.resolveTitle(context) });
    }

    /**
     * 异步发送 P1 严重级告警（fire-and-forget，不阻塞调用方）
     */
    async sendP1(context: AlertContext): Promise<void> {
        this.processAlert('P1', context).catch(err => {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to process P1 alert', error: err });
        });
    }

    private resolveTitle(context: AlertContext): string {
        return context.title || DEFAULT_TITLES[context.alertType] || DEFAULT_TITLES[AlertType.UNKNOWN];
    }

    private async processAlert(level: AlertLevel, context: AlertContext): Promise<void> {
        if (!this.webhookUrl) return;

        const key = `${level}:${context.alertType}`;
        const record = this.alertRecords.get(key);

        if (record) {
            record.pendingCount += 1;
            logger.debug({ kind: 'sys', component: COMPONENT, message: `Alert aggregating: ${key}, pendingCount: ${record.pendingCount}` });
            return;
        }

        const displayTitle = this.resolveTitle(context);
        this.alertRecords.set(key, {
            level,
            displayTitle,
            pendingCount: 0,
            timer: null,
        });
        this.startAggregationTimer(key);

        await this.dispatchToFeishu(level, { ...context, title: displayTitle });
    }

    private startAggregationTimer(key: string): void {
        const record = this.alertRecords.get(key);
        if (!record) return;

        const windowMs = record.level === 'P0' ? this.AGGREGATE_MS_P0 : this.AGGREGATE_MS_P1;

        record.timer = setTimeout(async () => {
            const rec = this.alertRecords.get(key);
            if (!rec) return;

            if (rec.pendingCount === 0) {
                this.alertRecords.delete(key);
                logger.debug({ kind: 'sys', component: COMPONENT, message: `Aggregation window expired with no new errors, cleared: ${key}` });
                return;
            }

            const count = rec.pendingCount;
            rec.pendingCount = 0;

            const windowMin = Math.round(windowMs / 60000);
            const aggContext: AlertContext = {
                alertType: key.split(':')[1] as AlertType,
                title: rec.displayTitle,
                message: `定时聚合上报：过去 ${windowMin} 分钟内，同类报错又发生了 ${count} 次`,
                meta: {
                    _aggregated_info: `⚠️ 过去 ${windowMin} 分钟内，同类报错又发生了 ${count} 次`,
                },
            };

            try {
                await this.dispatchToFeishu(rec.level, aggContext);
            } catch (err) {
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to send aggregated alert', error: err });
            }

            this.startAggregationTimer(key);
        }, windowMs);

        if (record.timer && typeof record.timer === 'object' && 'unref' in record.timer) {
            record.timer.unref();
        }
    }

    private async dispatchToFeishu(level: AlertLevel, context: AlertContext): Promise<void> {
        const isP0 = level === 'P0';
        const headerColor = isP0 ? 'red' : 'orange';
        const displayTitle = context.title || DEFAULT_TITLES[context.alertType] || DEFAULT_TITLES[AlertType.UNKNOWN];
        const headerTitle = isP0 ? `🚨 线上服务报警：${displayTitle}` : `🟠 P1 严重报警：${displayTitle}`;

        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

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

        let contentMd = `**⏰ 发生时间:**\n${timeStr}\n`;
        
        if (context.traceId) {
            contentMd += `**🆔 TraceID (追踪号):**\n${context.traceId}\n`;
        }
        
        if (context.userId) {
            contentMd += `**👤 受影响用户:**\n${context.userId}\n`;
        }
        
        if (context.userInput) {
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

        if (errorStack) {
            const stackPreview = errorStack.length > 500 ? errorStack.substring(0, 500) + '\n... (truncated)' : errorStack;
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