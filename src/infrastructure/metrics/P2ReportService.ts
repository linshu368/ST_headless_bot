import config from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import { metrics } from './MetricsCollector.js';
import crypto from 'crypto';

const COMPONENT = 'P2ReportService';
const REPORT_HOURS = 6;
const MAX_MODEL_ROWS = 12;
const WEBHOOK_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 3000;

// ==================== 数据类型 ====================

interface ModelStat {
    model: string;
    totalCalls: number;
    firstchunkTimeout: number;
    error: number;
    truncated: number;
    failureRate: string;
}

interface ConsistencyCheck {
    name: string;
    formula: string;
    left: number;
    right: number;
    passed: boolean;
}

interface P2ReportData {
    totalRequests: number;

    firstChunkGt8s: number;
    firstChunkGt8sRate: string;

    totalDurationGt25s: number;
    totalDurationGt25sRate: string;

    step2Success: number;
    step3Success: number;
    step2Rate: string;
    step3Rate: string;

    noDeduction: number;
    noDeductionRate: string;

    allStepsFailed: number;
    allStepsFailedRate: string;

    modelStats: ModelStat[];
    omittedModelCount: number;

    consistencyChecks: ConsistencyCheck[];

    periodLabel: string;
    generatedAt: string;
}

// ==================== 报表服务 ====================

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

    /**
     * 聚合过去 N 小时的指标数据，生成飞书卡片并发送到群B。
     * 供定时任务或手动调用。
     */
    async generateAndSend(hours: number = REPORT_HOURS): Promise<void> {
        if (!this.enabled) return;

        try {
            const data = await this.aggregate(hours);
            const card = this.buildCard(data);
            await this.sendToFeishu(card);
            logger.info({ kind: 'sys', component: COMPONENT, message: 'P2 report sent', meta: { totalRequests: data.totalRequests, period: data.periodLabel } });
        } catch (err) {
            logger.error({ kind: 'sys', component: COMPONENT, message: 'P2 report generation/send failed', error: err });
        }
    }

    /**
     * 启动定时报表推送。
     * 每分钟检查一次当前时间，在目标时刻（04:00、10:00、16:00、22:00）触发报表。
     * 使用分钟级轮询而非四个 setTimeout，避免长时间 drift 和进程重启后丢失调度。
     */
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
            const hh = now.getHours();
            const mm = now.getMinutes();
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

    // ==================== 聚合逻辑 ====================

    private async aggregate(hours: number): Promise<P2ReportData> {
        const [
            totalRequests, firstChunkGt8s, totalDurationGt25s,
            step2Success, step3Success, noDeduction, allStepsFailed,
            modelTotalCalls, modelFirstchunkTimeout, modelError, modelTruncated,
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
            metrics.sumModelMetricLastHours('error', hours),
            metrics.sumModelMetricLastHours('truncated', hours),
        ]);

        const allModels = new Set([
            ...modelTotalCalls.keys(),
            ...modelFirstchunkTimeout.keys(),
            ...modelError.keys(),
            ...modelTruncated.keys(),
        ]);

        const fullModelStats: ModelStat[] = [...allModels].map(model => {
            const total = modelTotalCalls.get(model) || 0;
            const timeout = modelFirstchunkTimeout.get(model) || 0;
            const err = modelError.get(model) || 0;
            const trunc = modelTruncated.get(model) || 0;
            return {
                model,
                totalCalls: total,
                firstchunkTimeout: timeout,
                error: err,
                truncated: trunc,
                failureRate: P2ReportService.rate(timeout + err, total),
            };
        }).sort((a, b) => b.totalCalls - a.totalCalls);

        const omittedModelCount = Math.max(0, fullModelStats.length - MAX_MODEL_ROWS);
        const modelStats = fullModelStats.slice(0, MAX_MODEL_ROWS);

        // 内生逻辑 check
        const totalModelCalls = [...modelTotalCalls.values()].reduce((s, v) => s + v, 0);
        const totalTruncated = [...modelTruncated.values()].reduce((s, v) => s + v, 0);

        // 到达 step2 的请求 = step2Success + step3Success + allStepsFailed
        // 到达 step3 的请求 = step3Success + allStepsFailed
        // 总模型调用 = totalRequests(每个请求至少1次) + 到达step2 + 到达step3
        const expectedModelCalls = totalRequests + step2Success + 2 * step3Success + 2 * allStepsFailed;

        const consistencyChecks: ConsistencyCheck[] = [
            {
                name: '模型总调用 = 请求数 + 重试产生的额外调用',
                formula: `${totalModelCalls} == ${totalRequests} + ${step2Success} + 2×${step3Success} + 2×${allStepsFailed}`,
                left: totalModelCalls,
                right: expectedModelCalls,
                passed: totalModelCalls === expectedModelCalls,
            },
            {
                name: '没扣积分 >= 截断 + 全部失败',
                formula: `${noDeduction} >= ${totalTruncated} + ${allStepsFailed}`,
                left: noDeduction,
                right: totalTruncated + allStepsFailed,
                passed: noDeduction >= totalTruncated + allStepsFailed,
            },
        ];

        return {
            totalRequests,
            firstChunkGt8s, firstChunkGt8sRate: P2ReportService.rate(firstChunkGt8s, totalRequests),
            totalDurationGt25s, totalDurationGt25sRate: P2ReportService.rate(totalDurationGt25s, totalRequests),
            step2Success, step3Success,
            step2Rate: P2ReportService.rate(step2Success, totalRequests),
            step3Rate: P2ReportService.rate(step3Success, totalRequests),
            noDeduction, noDeductionRate: P2ReportService.rate(noDeduction, totalRequests),
            allStepsFailed, allStepsFailedRate: P2ReportService.rate(allStepsFailed, totalRequests),
            modelStats,
            omittedModelCount,
            consistencyChecks,
            periodLabel: P2ReportService.buildPeriodLabel(hours),
            generatedAt: new Date().toISOString(),
        };
    }

    // ==================== 飞书互动卡片构建 ====================

    private buildCard(data: P2ReportData): object {
        const elements: any[] = [];

        // --- 零流量特殊提示 ---
        if (data.totalRequests === 0) {
            elements.push({
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: '**ℹ️ 当前统计窗口内无请求流量，以下数据均为 0。**\n可能原因：服务刚启动 / Redis 连接异常 / 无用户活跃。',
                },
            });
            elements.push({ tag: 'hr' });
        }

        // --- 第一块：基础指标 ---
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: [
                    `**📊 基础指标**（总请求数: **${data.totalRequests}**）`,
                    '',
                    '| 指标 | 次数 | 比例 |',
                    '| --- | --- | --- |',
                    `| 首字响应>8s | ${data.firstChunkGt8s} | ${data.firstChunkGt8sRate} |`,
                    `| 总耗时>25s | ${data.totalDurationGt25s} | ${data.totalDurationGt25sRate} |`,
                    `| Step2重试 | ${data.step2Success} | ${data.step2Rate} |`,
                    `| Step3重试 | ${data.step3Success} | ${data.step3Rate} |`,
                ].join('\n'),
            },
        });

        elements.push({ tag: 'hr' });

        // --- 第二块：可能升级的事件 ---
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: [
                    '**⚠️ 可能升级的事件**',
                    '',
                    `• 没扣积分: **${data.noDeduction}**次 (${data.noDeductionRate})`,
                    `• 全部失败(兜底回复): **${data.allStepsFailed}**次 (${data.allStepsFailedRate})`,
                ].join('\n'),
            },
        });

        elements.push({ tag: 'hr' });

        // --- 第三块：模型维度 ---
        const modelHeader = [
            '**🤖 模型维度**',
            '',
            '| 模型 | 总调用 | TTFT超时 | 报错 | 截断 | 失败率 |',
            '| --- | --- | --- | --- | --- | --- |',
        ];
        const modelRows = data.modelStats.map(m =>
            `| ${m.model} | ${m.totalCalls} | ${m.firstchunkTimeout} | ${m.error} | ${m.truncated} | ${m.failureRate} |`
        );
        if (data.omittedModelCount > 0) {
            modelRows.push(`| *(另有 ${data.omittedModelCount} 个模型已省略)* | | | | | |`);
        }
        if (data.modelStats.length === 0) {
            modelRows.push('| (无模型数据) | - | - | - | - | - |');
        }

        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: [...modelHeader, ...modelRows].join('\n'),
            },
        });

        elements.push({ tag: 'hr' });

        // --- 第四块：内生逻辑 Check ---
        const checkLines = data.consistencyChecks.map(c => {
            const icon = c.passed ? '✅' : '❌';
            const status = c.passed ? 'PASS' : 'FAIL';
            return `${icon} **${c.name}**\n      ${c.formula}  →  **${status}**`;
        });

        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**🔍 内生逻辑 Check**\n\n${checkLines.join('\n\n')}`,
            },
        });

        // --- 底部：时间信息 ---
        elements.push({
            tag: 'note',
            elements: [{
                tag: 'plain_text',
                content: `统计周期: ${data.periodLabel} | 生成时间: ${data.generatedAt}`,
            }],
        });

        return {
            msg_type: 'interactive',
            card: {
                config: { wide_screen_mode: true, enable_forward: true },
                header: {
                    title: { content: '🟢 P2 观察报表 — 过去6小时服务质量', tag: 'plain_text' },
                    template: 'green',
                },
                elements,
            },
        };
    }

    // ==================== 飞书 Webhook 发送（含重试） ====================

    private async sendToFeishu(payload: object): Promise<void> {
        for (let attempt = 0; attempt <= WEBHOOK_RETRIES; attempt++) {
            try {
                const body: any = { ...payload };

                // 每次重试重新生成 timestamp + 签名，避免飞书因时间戳过期拒绝
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

    // ==================== 工具方法 ====================

    private static rate(numerator: number, denominator: number): string {
        if (denominator === 0) return '0.00%';
        return (numerator / denominator * 100).toFixed(2) + '%';
    }

    private static buildPeriodLabel(hours: number): string {
        const now = new Date();
        const currentHour = new Date(now);
        currentHour.setMinutes(0, 0, 0);

        const startHour = new Date(currentHour.getTime() - (hours - 1) * 3600_000);

        const fmt = (d: Date) => {
            const y = d.getFullYear();
            const M = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const hh = String(d.getHours()).padStart(2, '0');
            return `${y}-${M}-${dd} ${hh}:00`;
        };

        return `${fmt(startHour)} ~ ${fmt(currentHour)} (${hours}个整点桶)`;
    }
}

export const p2Report = P2ReportService.getInstance();