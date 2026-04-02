/**
 * P2 报表纯计算逻辑
 *
 * 所有导出函数均为无副作用的纯函数，不依赖 Redis / config / logger，
 * 可直接用内存数据做单元测试。
 */

const MAX_MODEL_ROWS = 12;

// ==================== 时区工具 ====================

/** UTC Date 转北京时间 Date（偏移 8 小时） */
function toBeijing(d: Date): Date {
    return new Date(d.getTime() + 8 * 3600_000);
}

/** 格式化为北京时间字符串（带 +08:00 后缀） */
function formatBeijingTime(d: Date): string {
    const b = toBeijing(d);
    const y = b.getUTCFullYear();
    const M = String(b.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(b.getUTCDate()).padStart(2, '0');
    const hh = String(b.getUTCHours()).padStart(2, '0');
    const mm = String(b.getUTCMinutes()).padStart(2, '0');
    const ss = String(b.getUTCSeconds()).padStart(2, '0');
    return `${y}-${M}-${dd}T${hh}:${mm}:${ss}+08:00`;
}

// ==================== 数据类型 ====================

export interface ModelStat {
    model: string;
    totalCalls: number;
    // 用户不可感知
    firstchunkTimeout: number;
    emptyStream: number;
    apiError: number;
    networkError: number;
    invisibleFailureRate: string;
    // 用户可感知
    truncated: number;
    visibleFailureRate: string;
}

export interface ConsistencyCheck {
    name: string;
    formula: string;
    left: number;
    right: number;
    passed: boolean;
}

export interface P2ReportData {
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

/**
 * aggregate 从 Redis 读到的原始计数器值，
 * 作为 computeReport 的入参，解耦 IO 与计算。
 */
export interface RawMetrics {
    totalRequests: number;
    firstChunkGt8s: number;
    totalDurationGt25s: number;
    step2Success: number;
    step3Success: number;
    noDeduction: number;
    allStepsFailed: number;

    modelTotalCalls: Map<string, number>;
    modelFirstchunkTimeout: Map<string, number>;
    modelEmptyStream: Map<string, number>;
    modelApiError: Map<string, number>;
    modelNetworkError: Map<string, number>;
    modelTruncated: Map<string, number>;
}

// ==================== 纯函数 ====================

export function rate(numerator: number, denominator: number): string {
    if (denominator === 0) return '0.00%';
    return (numerator / denominator * 100).toFixed(2) + '%';
}

export function buildPeriodLabel(hours: number, now: Date = new Date()): string {
    const beijing = toBeijing(now);

    const currentHour = new Date(beijing);
    currentHour.setUTCMinutes(0, 0, 0);

    const startHour = new Date(currentHour.getTime() - (hours - 1) * 3600_000);

    const fmt = (d: Date) => {
        const y = d.getUTCFullYear();
        const M = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        return `${y}-${M}-${dd} ${hh}:00`;
    };

    return `${fmt(startHour)} ~ ${fmt(currentHour)} (${hours}个整点桶)`;
}

/**
 * 从原始计数器值计算完整的报表数据结构。
 * 纯函数：相同输入永远产生相同输出。
 */
export function computeReport(raw: RawMetrics, hours: number, now: Date = new Date()): P2ReportData {
    const {
        totalRequests, firstChunkGt8s, totalDurationGt25s,
        step2Success, step3Success, noDeduction, allStepsFailed,
        modelTotalCalls, modelFirstchunkTimeout, modelEmptyStream, modelApiError, modelNetworkError, modelTruncated,
    } = raw;

    // 合并所有出现过的模型名
    const allModels = new Set([
        ...modelTotalCalls.keys(),
        ...modelFirstchunkTimeout.keys(),
        ...modelEmptyStream.keys(),
        ...modelApiError.keys(),
        ...modelNetworkError.keys(),
        ...modelTruncated.keys(),
    ]);

    const fullModelStats: ModelStat[] = [...allModels].map(model => {
        const total = modelTotalCalls.get(model) || 0;
        const timeout = modelFirstchunkTimeout.get(model) || 0;
        const empty = modelEmptyStream.get(model) || 0;
        const api = modelApiError.get(model) || 0;
        const network = modelNetworkError.get(model) || 0;
        const trunc = modelTruncated.get(model) || 0;
        return {
            model,
            totalCalls: total,
            firstchunkTimeout: timeout,
            emptyStream: empty,
            apiError: api,
            networkError: network,
            invisibleFailureRate: rate(timeout + empty + api + network, total),
            truncated: trunc,
            visibleFailureRate: rate(trunc, total),
        };
    }).sort((a, b) => b.totalCalls - a.totalCalls);

    const omittedModelCount = Math.max(0, fullModelStats.length - MAX_MODEL_ROWS);
    const modelStats = fullModelStats.slice(0, MAX_MODEL_ROWS);

    // 内生逻辑 check
    const totalModelCalls = [...modelTotalCalls.values()].reduce((s, v) => s + v, 0);
    const totalTruncated = [...modelTruncated.values()].reduce((s, v) => s + v, 0);
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
        firstChunkGt8s, firstChunkGt8sRate: rate(firstChunkGt8s, totalRequests),
        totalDurationGt25s, totalDurationGt25sRate: rate(totalDurationGt25s, totalRequests),
        step2Success, step3Success,
        step2Rate: rate(step2Success, totalRequests),
        step3Rate: rate(step3Success, totalRequests),
        noDeduction, noDeductionRate: rate(noDeduction, totalRequests),
        allStepsFailed, allStepsFailedRate: rate(allStepsFailed, totalRequests),
        modelStats,
        omittedModelCount,
        consistencyChecks,
        periodLabel: buildPeriodLabel(hours, now),
        generatedAt: formatBeijingTime(now),
    };
}

/**
 * 将 P2ReportData 转换为飞书互动卡片 JSON payload。
 * 纯函数：不做网络调用，仅组装数据结构。
 */
export function buildCard(data: P2ReportData): object {
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
                `• 首字响应>8s：**${data.firstChunkGt8s}**次（${data.firstChunkGt8sRate}）`,
                `• 总耗时>25s：**${data.totalDurationGt25s}**次（${data.totalDurationGt25sRate}）`,
                `• Step2重试：**${data.step2Success}**次（${data.step2Rate}）`,
                `• Step3重试：**${data.step3Success}**次（${data.step3Rate}）`,
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
    const modelLines: string[] = [`**🤖 模型维度**`, ''];

    if (data.modelStats.length === 0) {
        modelLines.push('（无模型数据）');
    } else {
        for (const m of data.modelStats) {
            modelLines.push(
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `📦 **${m.model}**\u3000\u3000调用 ${m.totalCalls}`,
                `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌`,
                `\u3000\u3000🔴 用户可感知\u3000\u3000截断 ${m.truncated}\u3000\u3000失败率 ${m.visibleFailureRate}`,
                `\u3000\u3000⚪ 用户不可感知\u3000超时 ${m.firstchunkTimeout} · 空流 ${m.emptyStream} · API报错 ${m.apiError} · 网络 ${m.networkError}\u3000\u3000失败率 ${m.invisibleFailureRate}`,
            );
        }
        modelLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        if (data.omittedModelCount > 0) {
            modelLines.push(`*(另有 ${data.omittedModelCount} 个模型已省略)*`);
        }
    }

    elements.push({
        tag: 'div',
        text: {
            tag: 'lark_md',
            content: modelLines.join('\n'),
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