import { describe, it, expect } from 'vitest';
import {
    rate,
    buildPeriodLabel,
    computeReport,
    buildCard,
    type RawMetrics,
    type P2ReportData,
} from '../p2ReportLogic.js';

// ==================== 辅助函数 ====================

/** 构造一份基础的 RawMetrics，可按需覆盖字段 */
function makeRaw(overrides: Partial<RawMetrics> = {}): RawMetrics {
    return {
        totalRequests: 0,
        firstChunkGt8s: 0,
        totalDurationGt25s: 0,
        step2Success: 0,
        step3Success: 0,
        noDeduction: 0,
        allStepsFailed: 0,
        modelTotalCalls: new Map(),
        modelFirstchunkTimeout: new Map(),
        modelEmptyStream: new Map(),
        modelApiError: new Map(),
        modelNetworkError: new Map(),
        modelStrategyTruncated: new Map(),
        modelProviderTruncated: new Map(),
        ...overrides,
    };
}

const FIXED_NOW = new Date('2026-03-25T10:00:00+08:00');

// ==================== rate() ====================

describe('rate()', () => {
    it('正常比例计算，保留两位小数', () => {
        expect(rate(1, 100)).toBe('1.00%');
        expect(rate(3, 71)).toBe('4.23%');
    });

    it('分母为 0 时返回 0.00%', () => {
        expect(rate(0, 0)).toBe('0.00%');
        expect(rate(5, 0)).toBe('0.00%');
    });

    it('分子为 0 时返回 0.00%', () => {
        expect(rate(0, 100)).toBe('0.00%');
    });

    it('分子等于分母时返回 100.00%', () => {
        expect(rate(50, 50)).toBe('100.00%');
    });

    it('小数精度：四舍五入到两位', () => {
        // 1/3 = 33.3333...% → 33.33%
        expect(rate(1, 3)).toBe('33.33%');
        // 2/3 = 66.6666...% → 66.67%
        expect(rate(2, 3)).toBe('66.67%');
    });
});

// ==================== buildPeriodLabel() ====================

describe('buildPeriodLabel()', () => {
    it('6 小时窗口，标签包含起止时间和桶数', () => {
        const label = buildPeriodLabel(6, FIXED_NOW);
        expect(label).toContain('6个整点桶');
        // 10:00 往前 5 个小时 = 05:00 起始
        expect(label).toContain('05:00');
        expect(label).toContain('10:00');
    });

    it('1 小时窗口，起止时间相同', () => {
        const label = buildPeriodLabel(1, FIXED_NOW);
        expect(label).toContain('1个整点桶');
        // 起止都应该是 10:00
        expect(label).toContain('10:00 ~ 2026-03-25 10:00');
    });
});

// ==================== computeReport() ====================

describe('computeReport()', () => {

    // ---------- 零流量场景 ----------

    it('零流量：所有数值为 0，比例全部 0.00%', () => {
        const data = computeReport(makeRaw(), 6, FIXED_NOW);

        expect(data.totalRequests).toBe(0);
        expect(data.firstChunkGt8sRate).toBe('0.00%');
        expect(data.totalDurationGt25sRate).toBe('0.00%');
        expect(data.step2Rate).toBe('0.00%');
        expect(data.step3Rate).toBe('0.00%');
        expect(data.noDeductionRate).toBe('0.00%');
        expect(data.allStepsFailedRate).toBe('0.00%');
        expect(data.modelStats).toHaveLength(0);
    });

    // ---------- 正常数据场景（内生逻辑 check 全部通过） ----------

    it('正常数据：比例计算正确，内生逻辑 check 全 PASS', () => {
        // 构造数据使 check1 成立：
        //   totalModelCalls === totalRequests + step2Success + 2*step3Success + 2*allStepsFailed
        //   80 + 40 = 100 + 10 + 2*2 + 2*3 = 120 ✓
        // check2 成立：
        //   noDeduction >= strategyTruncated + providerTruncated + allStepsFailed
        //   8 >= (1+1) + 1 + 3 = 6 ✓
        const raw = makeRaw({
            totalRequests: 100,
            firstChunkGt8s: 5,
            totalDurationGt25s: 3,
            step2Success: 10,
            step3Success: 2,
            noDeduction: 8,
            allStepsFailed: 3,
            modelTotalCalls: new Map([['gpt-4', 80], ['claude-3', 40]]),
            modelFirstchunkTimeout: new Map([['gpt-4', 2], ['claude-3', 1]]),
            modelEmptyStream: new Map([['gpt-4', 1]]),
            modelApiError: new Map([['gpt-4', 1]]),
            modelNetworkError: new Map([['gpt-4', 1]]),
            modelStrategyTruncated: new Map([['gpt-4', 1], ['claude-3', 1]]),
            modelProviderTruncated: new Map([['claude-3', 1]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);

        // 基础比例
        expect(data.firstChunkGt8sRate).toBe('5.00%');
        expect(data.totalDurationGt25sRate).toBe('3.00%');
        expect(data.step2Rate).toBe('10.00%');
        expect(data.step3Rate).toBe('2.00%');
        expect(data.noDeductionRate).toBe('8.00%');
        expect(data.allStepsFailedRate).toBe('3.00%');

        // 内生逻辑全部 PASS
        expect(data.consistencyChecks).toHaveLength(2);
        expect(data.consistencyChecks[0].passed).toBe(true);
        expect(data.consistencyChecks[1].passed).toBe(true);
    });

    // ---------- 内生逻辑 check 失败场景 ----------

    it('check1 失败：模型总调用数 ≠ 预期值', () => {
        // expectedModelCalls = 100 + 10 + 2*2 + 2*3 = 120
        // 实际 modelTotalCalls = 50 + 40 = 90 ≠ 120
        const raw = makeRaw({
            totalRequests: 100,
            step2Success: 10,
            step3Success: 2,
            allStepsFailed: 3,
            modelTotalCalls: new Map([['gpt-4', 50], ['claude-3', 40]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);
        const check1 = data.consistencyChecks[0];

        expect(check1.passed).toBe(false);
        expect(check1.left).toBe(90);
        expect(check1.right).toBe(120);
    });

    it('check2 失败：没扣积分 < 策略截断 + 供应商截断 + 全部失败', () => {
        // noDeduction=1，strategyTruncated=3，providerTruncated=2，allStepsFailed=3 → 1 < 3+2+3=8
        const raw = makeRaw({
            totalRequests: 100,
            noDeduction: 1,
            allStepsFailed: 3,
            modelStrategyTruncated: new Map([['gpt-4', 3]]),
            modelProviderTruncated: new Map([['gpt-4', 2]]),
            modelTotalCalls: new Map([['gpt-4', 100]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);
        const check2 = data.consistencyChecks[1];

        expect(check2.passed).toBe(false);
        expect(check2.left).toBe(1);
        expect(check2.right).toBe(8);
    });

    // ---------- 模型维度 ----------

    it('模型按 totalCalls 降序排列', () => {
        const raw = makeRaw({
            modelTotalCalls: new Map([['small', 10], ['large', 500], ['medium', 100]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);
        const names = data.modelStats.map(m => m.model);

        expect(names).toEqual(['large', 'medium', 'small']);
    });

    it('不可感知失败率 = (timeout + emptyStream + apiError + networkError) / totalCalls', () => {
        const raw = makeRaw({
            modelTotalCalls: new Map([['gpt-4', 200]]),
            modelFirstchunkTimeout: new Map([['gpt-4', 3]]),
            modelEmptyStream: new Map([['gpt-4', 2]]),
            modelApiError: new Map([['gpt-4', 3]]),
            modelNetworkError: new Map([['gpt-4', 2]]),
            modelStrategyTruncated: new Map([['gpt-4', 1]]),
            modelProviderTruncated: new Map([['gpt-4', 1]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);

        // invisibleFailureRate = (3+2+3+2)/200 = 5.00%（truncated 不计入）
        expect(data.modelStats[0].invisibleFailureRate).toBe('5.00%');
        expect(data.modelStats[0].emptyStream).toBe(2);
        expect(data.modelStats[0].apiError).toBe(3);
        expect(data.modelStats[0].networkError).toBe(2);
        expect(data.modelStats[0].strategyTruncated).toBe(1);
        expect(data.modelStats[0].providerTruncated).toBe(1);
    });

    it('超过 12 个模型时截断并显示省略数量', () => {
        const totalCalls = new Map<string, number>();
        for (let i = 0; i < 15; i++) {
            totalCalls.set(`model-${i}`, 100 - i);
        }

        const raw = makeRaw({ modelTotalCalls: totalCalls });
        const data = computeReport(raw, 6, FIXED_NOW);

        expect(data.modelStats).toHaveLength(12);
        expect(data.omittedModelCount).toBe(3);
    });

    it('模型仅出现在 apiError map 而不在 totalCalls 中，totalCalls 视为 0', () => {
        const raw = makeRaw({
            modelApiError: new Map([['ghost-model', 5]]),
        });

        const data = computeReport(raw, 6, FIXED_NOW);

        expect(data.modelStats).toHaveLength(1);
        expect(data.modelStats[0].model).toBe('ghost-model');
        expect(data.modelStats[0].totalCalls).toBe(0);
        expect(data.modelStats[0].apiError).toBe(5);
        // 0 分母 → 0.00%
        expect(data.modelStats[0].invisibleFailureRate).toBe('0.00%');
    });

    // ---------- 元信息 ----------

    it('periodLabel 和 generatedAt 正确生成', () => {
        const data = computeReport(makeRaw(), 6, FIXED_NOW);

        expect(data.periodLabel).toContain('6个整点桶');
        expect(data.generatedAt).toBe('2026-03-25T10:00:00+08:00');
    });
});

// ==================== buildCard() ====================

describe('buildCard()', () => {

    /** 快捷方式：从 computeReport 拿一份数据再 buildCard */
    function makeCard(rawOverrides: Partial<RawMetrics> = {}): any {
        const data = computeReport(makeRaw(rawOverrides), 6, FIXED_NOW);
        return buildCard(data);
    }

    it('返回值顶层结构符合飞书互动卡片格式', () => {
        const card = makeCard({ totalRequests: 10 });

        expect(card).toHaveProperty('msg_type', 'interactive');
        expect(card).toHaveProperty('card');
        expect(card.card).toHaveProperty('header');
        expect(card.card).toHaveProperty('elements');
        expect(card.card.header.template).toBe('green');
    });

    it('零流量时卡片包含特殊提示文案', () => {
        const card = makeCard();
        const json = JSON.stringify(card);

        expect(json).toContain('当前统计窗口内无请求流量');
    });

    it('有流量时卡片不包含零流量提示', () => {
        const card = makeCard({ totalRequests: 50 });
        const json = JSON.stringify(card);

        expect(json).not.toContain('当前统计窗口内无请求流量');
    });

    it('卡片包含所有必要的区块：基础指标、可能升级、模型维度、内生逻辑', () => {
        const card = makeCard({ totalRequests: 50 });
        const json = JSON.stringify(card);

        expect(json).toContain('基础指标');
        expect(json).toContain('可能升级的事件');
        expect(json).toContain('模型维度');
        expect(json).toContain('内生逻辑 Check');
    });

    it('内生逻辑 check 失败时卡片包含 ❌ 和 FAIL', () => {
        // check1 一定失败：modelTotalCalls=50 ≠ expected=100+0+0+0=100
        const card = makeCard({
            totalRequests: 100,
            modelTotalCalls: new Map([['x', 50]]),
        });
        const json = JSON.stringify(card);

        expect(json).toContain('❌');
        expect(json).toContain('FAIL');
    });

    it('模型省略提示出现在卡片中', () => {
        const totalCalls = new Map<string, number>();
        for (let i = 0; i < 15; i++) {
            totalCalls.set(`m-${i}`, 100 - i);
        }
        const card = makeCard({ modelTotalCalls: totalCalls });
        const json = JSON.stringify(card);

        expect(json).toContain('另有 3 个模型已省略');
    });
});