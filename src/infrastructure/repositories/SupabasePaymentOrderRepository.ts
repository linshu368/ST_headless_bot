import { supabase } from '../supabase/SupabaseClient.js';
import { logger } from '../../platform/logger.js';
import type { PaymentType, PaymentOrder, PaymentOrderStatus } from '../../types/payment.js';

const COMPONENT = 'PaymentOrderRepo';
const TABLE = 'payment_orders';

export class SupabasePaymentOrderRepository {

    async createOrder(params: {
        transactionId: string;
        userId: string;
        amount: number;
        creditsAmount: number;
        paymentProvider: PaymentType;
    }): Promise<boolean> {
        if (!supabase) return false;

        try {
            const { error } = await supabase.from(TABLE).insert({
                transaction_id: params.transactionId,
                user_id: params.userId,
                amount: params.amount,
                credits_amount: params.creditsAmount,
                payment_status: 'pending' as PaymentOrderStatus,
                payment_provider: params.paymentProvider,
                provider_transaction_id: null,
                credits_added: false,
            });

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: 'Failed to create payment order',
                    error, meta: { transactionId: params.transactionId, userId: params.userId },
                });
                return false;
            }
            return true;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception creating payment order',
                error: err, meta: { transactionId: params.transactionId },
            });
            return false;
        }
    }

    async findByTransactionId(transactionId: string): Promise<PaymentOrder | null> {
        if (!supabase) return null;

        try {
            const { data, error } = await supabase
                .from(TABLE)
                .select('*')
                .eq('transaction_id', transactionId)
                .single();

            if (error || !data) return null;
            return data as PaymentOrder;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception querying payment order',
                error: err, meta: { transactionId },
            });
            return null;
        }
    }

    /**
     * 标记订单为已支付（completed），同时回填渠道侧流水号。
     * WHERE 条件含 payment_status = 'pending'，天然防重。
     * @returns 受影响行数（0 = 已经被处理过，1 = 本次更新成功）
     */
    async markCompleted(transactionId: string, providerTransactionId?: string): Promise<number> {
        if (!supabase) return 0;

        try {
            const updatePayload: Record<string, unknown> = { payment_status: 'completed' };
            if (providerTransactionId) {
                updatePayload.provider_transaction_id = providerTransactionId;
            }

            const { data, error } = await supabase
                .from(TABLE)
                .update(updatePayload)
                .eq('transaction_id', transactionId)
                .eq('payment_status', 'pending')
                .select('transaction_id');

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: 'Failed to mark order completed',
                    error, meta: { transactionId },
                });
                return 0;
            }
            return data?.length ?? 0;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception marking order completed',
                error: err, meta: { transactionId },
            });
            return 0;
        }
    }

    /**
     * 标记积分已到账。
     * WHERE 条件含 credits_added = false，防止重复入账。
     * @returns 受影响行数
     */
    async markCreditsAdded(transactionId: string): Promise<number> {
        if (!supabase) return 0;

        try {
            const { data, error } = await supabase
                .from(TABLE)
                .update({ credits_added: true })
                .eq('transaction_id', transactionId)
                .eq('payment_status', 'completed')
                .eq('credits_added', false)
                .select('transaction_id');

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: 'Failed to mark credits added',
                    error, meta: { transactionId },
                });
                return 0;
            }
            return data?.length ?? 0;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception marking credits added',
                error: err, meta: { transactionId },
            });
            return 0;
        }
    }

    async markFailed(transactionId: string): Promise<boolean> {
        if (!supabase) return false;

        try {
            const { error } = await supabase
                .from(TABLE)
                .update({ payment_status: 'failed' as PaymentOrderStatus })
                .eq('transaction_id', transactionId)
                .eq('payment_status', 'pending');

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: 'Failed to mark order failed',
                    error, meta: { transactionId },
                });
                return false;
            }
            return true;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception marking order failed',
                error: err, meta: { transactionId },
            });
            return false;
        }
    }

    /**
     * 批量将超时的 pending 订单标记为 expired。
     * @returns 受影响行数
     */
    async expireStaleOrders(expireBeforeMs: number = 15 * 60 * 1000): Promise<number> {
        if (!supabase) return 0;

        try {
            const cutoff = new Date(Date.now() - expireBeforeMs).toISOString();

            const { data, error } = await supabase
                .from(TABLE)
                .update({ payment_status: 'expired' as PaymentOrderStatus })
                .eq('payment_status', 'pending')
                .lt('created_at', cutoff)
                .select('transaction_id');

            if (error) {
                logger.error({
                    kind: 'infra', component: COMPONENT,
                    message: 'Failed to expire stale orders',
                    error,
                });
                return 0;
            }

            const count = data?.length ?? 0;
            if (count > 0) {
                logger.info({
                    kind: 'biz', component: COMPONENT,
                    message: `Expired ${count} stale orders`,
                    meta: { count, cutoff },
                });
            }
            return count;
        } catch (err) {
            logger.error({
                kind: 'infra', component: COMPONENT,
                message: 'Exception expiring stale orders',
                error: err,
            });
            return 0;
        }
    }
}
