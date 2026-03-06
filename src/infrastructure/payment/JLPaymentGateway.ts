import CryptoJS from 'crypto-js';
import axios from 'axios';
import { logger } from '../../platform/logger.js';
import config from '../../platform/config.js';
import type { CreatePaymentParams, PaymentNotifyData, PaymentResult, OrderQueryResult } from '../../types/payment.js';

const COMPONENT = 'JLPaymentGateway';

/**
 * 金鳞支付网关适配器 (Layer 4 Infrastructure)
 * 职责：封装第三方支付平台 API 调用
 */
export class JLPaymentGateway {
    private merchantId: string;
    private merchantKey: string;
    private baseUrl: string;
    private notifyUrl: string;
    private returnUrl: string;

    constructor(options?: {
        merchantId?: string;
        merchantKey?: string;
        baseUrl?: string;
        notifyUrl?: string;
        returnUrl?: string;
    }) {
        this.merchantId = options?.merchantId || config.payment.merchantId;
        this.merchantKey = options?.merchantKey || config.payment.merchantKey;
        this.baseUrl = options?.baseUrl || config.payment.baseUrl;
        this.notifyUrl = options?.notifyUrl || config.payment.notifyUrl;
        this.returnUrl = options?.returnUrl || config.payment.returnUrl;
    }

    /**
     * MD5 签名算法
     * 按照参数名 ASCII 码从小到大排序，拼接后加上商户密钥进行 MD5 加密
     */
    private sign(params: Record<string, string | undefined>): string {
        const sortedKeys = Object.keys(params)
            .filter(key => key !== 'sign' && key !== 'sign_type' && params[key] !== '' && params[key] !== undefined)
            .sort();

        const stringA = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
        const stringSignTemp = stringA + this.merchantKey;
        return CryptoJS.MD5(stringSignTemp).toString();
    }

    /**
     * 验证回调签名
     */
    verifyNotifySign(notifyData: PaymentNotifyData): boolean {
        const params: Record<string, string | undefined> = { ...notifyData };
        const receivedSign = params.sign;
        delete params.sign;

        const calculatedSign = this.sign(params);
        const isValid = receivedSign === calculatedSign;

        if (!isValid) {
            logger.warn({
                kind: 'infra',
                component: COMPONENT,
                message: 'Signature verification failed',
                meta: { outTradeNo: notifyData.out_trade_no },
            });
        }
        return isValid;
    }

    /**
     * 创建支付订单
     */
    async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
        const paymentParams: Record<string, string | undefined> = {
            pid: this.merchantId,
            type: params.type,
            out_trade_no: params.outTradeNo,
            notify_url: this.notifyUrl,
            return_url: this.returnUrl,
            name: params.productName,
            money: params.amount,
            clientip: '127.0.0.1',
            device: 'jump',
            param: params.userId,
            sign_type: 'MD5',
        };

        paymentParams.sign = this.sign(paymentParams);

        logger.info({
            kind: 'infra',
            component: COMPONENT,
            message: 'Creating payment order',
            meta: { type: params.type, amount: params.amount, userId: params.userId, orderId: params.outTradeNo },
        });

        try {
            const response = await axios.post(
                `${this.baseUrl}/mapi.php`,
                paymentParams,
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    transformRequest: [(data: Record<string, string | undefined>) => {
                        return Object.keys(data)
                            .filter(key => data[key] !== undefined)
                            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key] as string)}`)
                            .join('&');
                    }],
                    timeout: 10000,
                }
            );

            const result = response.data;
            const paymentUrl = result.payurl || result.url;

            if (result.code === 1 && paymentUrl) {
                logger.info({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Payment order created successfully',
                    meta: { orderId: params.outTradeNo },
                });
                return { success: true, paymentUrl, orderId: params.outTradeNo };
            } else {
                logger.warn({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Payment order creation failed',
                    meta: { orderId: params.outTradeNo, code: result.code, msg: result.msg },
                });
                return { success: false, errorMessage: result.msg || '创建订单失败' };
            }
        } catch (error) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Payment API error',
                error,
                meta: { orderId: params.outTradeNo },
            });
            return { success: false, errorMessage: '支付系统暂时不可用' };
        }
    }

    /**
     * 查询订单状态
     */
    async queryOrder(outTradeNo: string): Promise<OrderQueryResult> {
        try {
            const response = await axios.get(`${this.baseUrl}/api.php`, {
                params: {
                    act: 'order',
                    pid: this.merchantId,
                    key: this.merchantKey,
                    out_trade_no: outTradeNo,
                },
                timeout: 10000,
            });

            const result = response.data;

            if (result.code === 1) {
                logger.debug({
                    kind: 'infra',
                    component: COMPONENT,
                    message: 'Order query successful',
                    meta: { outTradeNo, status: result.status },
                });

                let status: 'paid' | 'pending' | 'expired' = 'pending';
                if (result.status === '1') {
                    status = 'paid';
                } else if (this._isOrderExpired(outTradeNo)) {
                    status = 'expired';
                }

                return {
                    status,
                    amount: result.money,
                    paymentType: result.type,
                };
            }

            logger.warn({
                kind: 'infra',
                component: COMPONENT,
                message: 'Order query returned error',
                meta: { outTradeNo, msg: result.msg },
            });
            return { status: 'failed' };
        } catch (error) {
            logger.error({
                kind: 'infra',
                component: COMPONENT,
                message: 'Order query failed',
                error,
                meta: { outTradeNo },
            });
            return { status: 'failed' };
        }
    }

    private static readonly ORDER_EXPIRE_MS = 15 * 60 * 1000;

    /**
     * 根据订单号中的时间戳判断是否已超过 15 分钟
     * 订单号格式: TG_{userId}_{timestamp}_{random}
     */
    private _isOrderExpired(outTradeNo: string): boolean {
        const parts = outTradeNo.split('_');
        if (parts.length < 3) return false;
        const ts = parseInt(parts[2], 10);
        if (isNaN(ts)) return false;
        return Date.now() - ts > JLPaymentGateway.ORDER_EXPIRE_MS;
    }

    getMerchantId(): string {
        return this.merchantId;
    }
}

/** 单例实例（聊天 Bot 使用） */
export const paymentGateway = new JLPaymentGateway();
