/**
 * 支付系统类型定义
 * 供聊天 Bot 和支付 Service 共享使用
 */

/** 支付方式代码 */
export type PaymentType = 'alipay' | 'wxpay' | 'usdt';

/** 支付方式配置 */
export interface PaymentMethodConfig {
    code: PaymentType;
    name: string;
    icon: string;
    description: string;
    device?: string;
}

/** 可用的支付方式列表 */
export const PAYMENT_METHODS: PaymentMethodConfig[] = [
    { code: 'alipay', name: '支付宝', icon: '💳', description: '支付宝扫码支付', device: 'jump' },
    { code: 'wxpay', name: '微信支付', icon: '💚', description: '微信扫码支付', device: 'jump' },
    { code: 'usdt', name: 'USDT', icon: '🔵', description: 'USDT(TRC20)支付', device: 'mobile' }
];

/** 创建支付订单参数 */
export interface CreatePaymentParams {
    type: PaymentType;
    outTradeNo: string;
    amount: string;
    userId: string;
    productName: string;
}

/** 支付结果 */
export interface PaymentResult {
    success: boolean;
    paymentUrl?: string;
    errorMessage?: string;
    orderId?: string;
}

/** 支付回调通知数据 */
export interface PaymentNotifyData {
    trade_no: string;
    out_trade_no: string;
    total_fee: string;
    trade_status: string;
    param?: string;
    type?: string;
    sign: string;
    [key: string]: string | undefined;
}

/** 订单查询结果 */
export interface OrderQueryResult {
    status: 'paid' | 'pending' | 'failed';
    amount?: string;
    paymentType?: string;
}

/** 支付 Service → Bot Service 内部通信数据 */
export interface InternalPaymentEvent {
    userId: string;
    orderId: string;
    amount: string;
    paymentType: string;
}
