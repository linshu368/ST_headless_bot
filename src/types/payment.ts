/**
 * 支付系统类型定义
 * 供聊天 Bot 和支付 Service 共享使用
 */

/** 支付方式代码 */
export type PaymentType = 'alipay' | 'wxpay';

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
];

/** 星尘套餐定义 */
export interface CreditsPlan {
    credits: number;   // 星尘数量（展示给用户）
    priceCNY: number;  // 实际支付金额（人民币）
}

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

/** 支付回调通知数据（V1 接口） */
export interface PaymentNotifyData {
    pid: string;
    trade_no: string;
    out_trade_no: string;
    type: string;
    name: string;
    money: string;
    trade_status: string;
    param?: string;
    sign: string;
    sign_type?: string;
    [key: string]: string | undefined;
}

/** 订单查询结果 */
export interface OrderQueryResult {
    status: 'paid' | 'pending' | 'expired' | 'failed';
    amount?: string;
    paymentType?: string;
}

/** 支付 Service → Bot Service 内部通信数据 */
export interface InternalPaymentEvent {
    userId: string;
    orderId: string;
    amount: string;
    paymentType: string;
    providerTransactionId?: string;
}

/** 支付订单状态 */
export type PaymentOrderStatus = 'pending' | 'completed' | 'failed' | 'expired';

/** 支付订单持久化记录 */
export interface PaymentOrder {
    transaction_id: string;
    user_id: string;
    amount: number;
    credits_amount: number;
    payment_status: PaymentOrderStatus;
    payment_provider: PaymentType;
    provider_transaction_id: string | null;
    credits_added: boolean;
    created_at: string;
}
