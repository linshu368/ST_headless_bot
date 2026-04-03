import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import { metrics } from './MetricsCollector.js';
import { computeReport, buildCard, type RawMetrics } from './p2ReportLogic.js';
import crypto from 'crypto';

const COMPONENT = 'P2ReportService';
const REPORT_HOURS = 6;
const WEBHOOK_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 3000;

/**
 * P2 报表服务（IO 编排层）
 *
 * 职责：读 Redis → 调纯函数计算 → 发飞书 Webhook + 定时调度。
 * 所有纯计算逻辑已提取到 p2ReportLogic.ts，本类只做 IO 和副作用。
 */
class P2ReportService {
    private static instance: P2ReportService;
    private readonly webhookUrl: string;
    private readonly webhookSecret: string;
    private readonly enabled: boolean;
    private reportTimer: ReturnType<typeof setInterval> | null = null;

    private constructor() {
        this.webhookUrl = config.alerts.feishuReportWebhookUrl;
        this.webhookSecret = config.alerts.feishuReportWebhookSecret;
        this.enabled = !!this.webhookUrl;

        if (!this.enabled) {
            logger.warn({ kind: 'sys', component: COMPONENT, message: 'P2 Report disabled: FEISHU_REPORT_WEBHOOK_URL not configured' });
        } else {
            logger.info({ kind: 'sys', component: COMPONENT, message: 'P2ReportService initialized' });
        }
    }

    static getInstance(): P2ReportService {
        if (!P2ReportService.instance) {
            P2ReportService.instance = new P2ReportService();
        }
        return P2ReportService.instance;
    }

    // ==================== 公开 API ====================

    async generateAndSend(hours: number = REPORT_HOURS): Promise<void> {
        if (!this.enabled) return;

        try {
            const raw = await this.fetchRawMetrics(hours);
            const data = computeReport(raw, hours);
            const card = buildCard(data);
            await this.sendToFeishu(card);
            logger.info({ kind: 'sys', component: COMPONENT, message: 'P2 report sent', meta: { totalRequests: data.totalRequests, period: data.periodLabel } });
        } catch (err) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'P2 report generation/send failed', error: err });
        }
    }

    startSchedule(): void {
        if (this.reportTimer) return;
        if (!this.enabled) {
            logger.info({ kind: 'sys', component: COMPONENT, message: 'Schedule not started (webhook not configured)' });
            return;
        }

        const SCHEDULE = [
            { hour: 4,  minute: 0 },
            { hour: 10, minute: 0 },
            { hour: 16, minute: 0 },
            { hour: 22, minute: 0 },
        ];
        let lastFiredKey = '';

        this.reportTimer = setInterval(() => {
            const now = new Date();
            // ========== 修复：UTC → 北京时间 ==========
            const utcH = now.getUTCHours();
            const utcM = now.getUTCMinutes();
            const hh = (utcH + 8) % 24;   // UTC+8
            const mm = utcM;
            // ==========================================
            const key = `${hh}:${mm}`;

            if (key === lastFiredKey) return;

            const match = SCHEDULE.find(s => s.hour === hh && s.minute === mm);
            if (match) {
                lastFiredKey = key;
                logger.info({ kind: 'sys', component: COMPONENT, message: `Scheduled P2 report triggered at ${key}` });
                this.generateAndSend(REPORT_HOURS).catch(err => {
                    logger.error({ kind: 'sys', component: COMPONENT, message: 'Scheduled report failed', error: err });
                });
            }
        }, 60_000);

        if (this.reportTimer && typeof this.reportTimer === 'object' && 'unref' in this.reportTimer) {
            this.reportTimer.unref();
        }

        logger.info({ kind: 'sys', component: COMPONENT, message: 'P2 report schedule started (04:00, 10:00, 16:00, 22:00)' });
    }

    stopSchedule(): void {
        if (this.reportTimer) {
            clearInterval(this.reportTimer);
            this.reportTimer = null;
        }
    }

    // ==================== IO 层：Redis 数据获取 ====================

    private async fetchRawMetrics(hours: number): Promise<RawMetrics> {
        const [
            totalRequests, firstChunkGt8s, totalDurationGt25s,
            step2Success, step3Success, noDeduction, allStepsFailed,
            modelTotalCalls, modelFirstchunkTimeout, modelEmptyStream, modelApiError, modelNetworkError,
            modelStrategyTruncated, modelProviderTruncated,
        ] = await Promise.all([
            metrics.sumLastHours('total_requests', hours),
            metrics.sumLastHours('first_chunk_gt8s', hours),
            metrics.sumLastHours('total_duration_gt25s', hours),
            metrics.sumLastHours('step2_success', hours),
            metrics.sumLastHours('step3_success', hours),
            metrics.sumLastHours('no_deduction', hours),
            metrics.sumLastHours('all_steps_failed', hours),
            metrics.sumModelMetricLastHours('total_calls', hours),
            metrics.sumModelMetricLastHours('firstchunk_timeout', hours),
            metrics.sumModelMetricLastHours('empty_stream', hours),
            metrics.sumModelMetricLastHours('api_error', hours),
            metrics.sumModelMetricLastHours('network_error', hours),
            metrics.sumModelMetricLastHours('strategy_truncated', hours),
            metrics.sumModelMetricLastHours('provider_truncated', hours),
        ]);

        return {
            totalRequests, firstChunkGt8s, totalDurationGt25s,
            step2Success, step3Success, noDeduction, allStepsFailed,
            modelTotalCalls, modelFirstchunkTimeout, modelEmptyStream, modelApiError, modelNetworkError,
            modelStrategyTruncated, modelProviderTruncated,
        };
    }

    // ==================== IO 层：飞书 Webhook（含重试） ====================

    private async sendToFeishu(payload: object): Promise<void> {
        for (let attempt = 0; attempt <= WEBHOOK_RETRIES; attempt++) {
            try {
                const body: any = { ...payload };

                if (this.webhookSecret) {
                    const timestamp = Math.floor(Date.now() / 1000).toString();
                    const signStr = `${timestamp}\n${this.webhookSecret}`;
                    const signature = crypto.createHmac('sha256', signStr).update('').digest('base64');
                    body.timestamp = timestamp;
                    body.sign = signature;
                }

                const response = await fetch(this.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                if (response.ok) return;

                const errText = await response.text();
                if (attempt < WEBHOOK_RETRIES) {
                    logger.warn({
                        kind: 'sys', component: COMPONENT,
                        message: `Feishu webhook attempt ${attempt + 1}/${WEBHOOK_RETRIES + 1} failed, retrying...`,
                        meta: { status: response.status, errText },
                    });
                    await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * (attempt + 1)));
                    continue;
                }
                throw new Error(`Feishu report webhook failed after ${WEBHOOK_RETRIES + 1} attempts: ${response.status} ${errText}`);
            } catch (err) {
                if (attempt >= WEBHOOK_RETRIES) throw err;
                logger.warn({
                    kind: 'sys', component: COMPONENT,
                    message: `Feishu webhook attempt ${attempt + 1}/${WEBHOOK_RETRIES + 1} error, retrying...`,
                    meta: { error: String(err) },
                });
                await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * (attempt + 1)));
            }
        }
    }
}

export const p2Report = P2ReportService.getInstance();
