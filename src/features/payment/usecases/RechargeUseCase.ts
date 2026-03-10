import { logger } from '../../../platform/logger.js';
import { paymentGateway, JLPaymentGateway } from '../../../infrastructure/payment/JLPaymentGateway.js';
import type { PaymentType, PaymentResult, OrderQueryResult } from '../../../types/payment.js';
import { generateOrderNo, calculateCreditsFromRecharge, findPlanByPrice, formatCredits } from '../domain/rechargeRules.js';
import type { ICreditsRepository } from '../../credits/ports/ICreditsRepository.js';
import { SupabasePaymentOrderRepository } from '../../../infrastructure/repositories/SupabasePaymentOrderRepository.js';

const COMPONENT = 'RechargeUseCase';

/**
 * 充值用例 (Layer 2 UseCase)
 * 职责：
 * 1. 创建支付订单（含持久化）
 * 2. 处理支付成功回调
 * 3. 协调积分入账
 */
export class RechargeUseCase {
    private creditsRepository: ICreditsRepository;
    private gateway: JLPaymentGateway;
    private orderRepository: SupabasePaymentOrderRepository;

    constructor(
        creditsRepository: ICreditsRepository,
        gateway?: JLPaymentGateway,
        orderRepository?: SupabasePaymentOrderRepository,
    ) {
        this.creditsRepository = creditsRepository;
        this.gateway = gateway || paymentGateway;
        this.orderRepository = orderRepository || new SupabasePaymentOrderRepository();
    }

    /**
     * 创建充值订单
     * @param userId Telegram 用户 ID
     * @param amount 充值金额（人民币）
     * @param paymentType 支付方式
     * @returns 支付结果（包含支付链接）
     */
    async createRechargeOrder(
        userId: string,
        amount: number,
        paymentType: PaymentType
    ): Promise<PaymentResult> {
        const orderId = generateOrderNo(userId);

        logger.info({
            kind: 'biz',
            component: COMPONENT,
            message: 'Creating recharge order',
            meta: { userId, amount, paymentType, orderId },
        });

        const result = await this.gateway.createPayment({
            type: paymentType,
            outTradeNo: orderId,
            amount: amount.toFixed(2),
            userId,
            productName: `星尘充值${amount}元`,
        });

        if (result.success) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'Recharge order created',
                meta: { userId, orderId, paymentUrl: result.paymentUrl?.slice(0, 50) },
            });

            const plan = await findPlanByPrice(amount);
            const creditsAmount = plan?.credits ?? 0;
            const persisted = await this.orderRepository.createOrder({
                transactionId: orderId,
                userId,
                amount,
                creditsAmount,
                paymentProvider: paymentType,
            });
            if (!persisted) {
                logger.warn({
                    kind: 'biz', component: COMPONENT,
                    message: 'Order created but failed to persist to DB (non-blocking)',
                    meta: { userId, orderId },
                });
            }
        } else {
            logger.warn({
                kind: 'biz',
                component: COMPONENT,
                message: 'Recharge order failed',
                meta: { userId, orderId, error: result.errorMessage },
            });
        }

        return result;
    }

    /**
     * 处理支付成功（由支付 Service 回调触发）
     * @param userId Telegram 用户 ID
     * @param amountStr 支付金额字符串
     * @param orderId 订单号
     * @param paymentType 支付方式
     * @returns 充值结果
     */
    async handlePaymentSuccess(
        userId: string,
        amountStr: string,
        orderId: string,
        paymentType: string
    ): Promise<{ success: boolean; mainCredits: number; bonusCredits: number }> {
        const amount = parseFloat(amountStr);

        logger.info({
            kind: 'biz',
            component: COMPONENT,
            message: 'Processing payment success',
            meta: { userId, amount, orderId, paymentType },
        });

        const { mainCredits, bonusCredits } = await calculateCreditsFromRecharge(amount);

        logger.debug({
            kind: 'biz',
            component: COMPONENT,
            message: 'Credits calculated',
            meta: { userId, mainCredits, bonusCredits },
        });

        // 2. 入账积分
        const success = await this.creditsRepository.addCredits(userId, mainCredits, bonusCredits);

        if (success) {
            logger.info({
                kind: 'biz',
                component: COMPONENT,
                message: 'Credits added successfully',
                meta: { userId, mainCredits, bonusCredits, orderId },
            });
        } else {
            logger.error({
                kind: 'biz',
                component: COMPONENT,
                message: 'Failed to add credits',
                meta: { userId, orderId },
            });
        }

        return { success, mainCredits, bonusCredits };
    }

    /**
     * 查询订单状态
     */
    async queryOrderStatus(orderId: string): Promise<OrderQueryResult> {
        return await this.gateway.queryOrder(orderId);
    }

    getOrderRepository(): SupabasePaymentOrderRepository {
        return this.orderRepository;
    }

    /**
     * 生成支付成功通知文案
     */
    static formatSuccessNotification(
        amount: number,
        mainCredits: number,
        bonusCredits: number,
        orderId: string,
        paymentType: string
    ): string {
        let message = `✅ **充值成功！**\n\n`;
        message += `💰 充值金额：¥${amount}\n`;
        message += `📋 订单号：\`${orderId}\`\n`;
        message += `✨ 获得星尘：${formatCredits(mainCredits)}\n`;

        if (bonusCredits > 0) {
            message += `🎁 额外赠送：${formatCredits(bonusCredits)}\n`;
        }

        message += `\n感谢您的支持！`;

        return message;
    }
}
