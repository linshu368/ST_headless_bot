import TelegramBot from 'node-telegram-bot-api';
import { PAYMENT_METHODS, PaymentType } from '../../types/payment.js';
import { RECHARGE_AMOUNTS } from '../payment/domain/rechargeRules.js';

/**
 * 支付 UI 处理器 (Layer 1)
 * 职责：生成支付相关的 Telegram 键盘和消息
 */
export class PaymentUIHandler {

    /**
     * 创建支付方式选择键盘
     */
    static createPaymentMethodKeyboard(): TelegramBot.InlineKeyboardMarkup {
        const rows: TelegramBot.InlineKeyboardButton[][] = PAYMENT_METHODS.map(method => ([
            { text: `${method.icon} ${method.name}`, callback_data: `pay_method:${method.code}` }
        ]));

        return { inline_keyboard: rows };
    }

    /**
     * 创建金额选择键盘
     */
    static createAmountKeyboard(paymentType: PaymentType): TelegramBot.InlineKeyboardMarkup {
        const rows: TelegramBot.InlineKeyboardButton[][] = [];

        // 每行4个按钮
        for (let i = 0; i < RECHARGE_AMOUNTS.length; i += 4) {
            const row = RECHARGE_AMOUNTS.slice(i, i + 4).map(amount => ({
                text: `¥${amount}`,
                callback_data: `pay_amount:${amount}:${paymentType}`
            }));
            rows.push(row);
        }

        // 返回按钮
        rows.push([{ text: '🔙 返回选择支付方式', callback_data: 'pay_back' }]);

        return { inline_keyboard: rows };
    }

    /**
     * 创建支付订单消息键盘
     */
    static createPaymentOrderKeyboard(paymentUrl: string, orderId: string): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: '💳 立即支付', url: paymentUrl }],
                [
                    { text: '📋 查看状态', callback_data: `pay_check:${orderId}` },
                    { text: '🔄 返回上一步', callback_data: 'pay_back' }
                ]
            ]
        };
    }

    /**
     * 创建充值入口按钮（添加到主菜单）
     */
    static createRechargeButton(): TelegramBot.KeyboardButton {
        return { text: '💰 充值' };
    }

    /**
     * 获取支付方式显示名称
     */
    static getPaymentMethodName(code: string): string {
        const method = PAYMENT_METHODS.find(m => m.code === code);
        return method ? `${method.icon} ${method.name}` : code;
    }

    /**
     * 获取充值入口消息
     */
    static getRechargeWelcomeMessage(): string {
        return `💰 **星尘充值**

星尘是您与 AI 角色对话的能量来源。

📌 **支持的支付方式：**
💳 支付宝 - 扫码即付
💚 微信支付 - 扫码即付

请选择支付方式：`;
    }

    /**
     * 获取金额选择消息
     */
    static getAmountSelectionMessage(paymentType: PaymentType): string {
        const method = PAYMENT_METHODS.find(m => m.code === paymentType);
        const methodName = method ? `${method.icon} ${method.name}` : paymentType;

        return `${methodName}

${method?.description || ''}

💡 充值越多，赠送越多：
• 充 ¥100 → 送 5%
• 充 ¥200 → 送 10%
• 充 ¥500 → 送 15%

请选择充值金额：`;
    }

    /**
     * 获取订单创建成功消息
     */
    static getOrderCreatedMessage(
        orderId: string,
        amount: number,
        paymentType: PaymentType
    ): string {
        const methodName = PaymentUIHandler.getPaymentMethodName(paymentType);

        return `✅ **订单已创建**

订单将于15分钟后关闭哦~~
--------------------------------------
📋 订单信息：
• 订单号：\`${orderId}\`
• 充值金额：${amount}元
• 支付方式：${methodName}
--------------------------------------

点击下方按钮开始支付 ⬇️`;
    }

    /**
     * 获取订单查询结果消息
     */
    static getOrderStatusMessage(
        orderId: string,
        status: 'paid' | 'pending' | 'expired' | 'failed',
        paymentType?: string,
        amount?: string
    ): string {
        const methodName = paymentType ? PaymentUIHandler.getPaymentMethodName(paymentType) : '';

        if (status === 'expired') {
            return `超时未支付，本次订单（订单号：\`${orderId}\`）已取消`;
        }

        if (status === 'pending') {
            return `⏳ 等待支付

订单将于15分钟后关闭哦~~
------------------------------------
📋 订单信息：
• 订单号：\`${orderId}\`${methodName ? `\n• 支付方式：${methodName}` : ''}${amount ? `\n• 支付金额：${amount}元` : ''}
------------------------------------
（如果客官已经支付完成，请稍等3分钟哦，后台正加紧为您补充星尘）`;
        }

        if (status === 'failed') {
            return `❌ 查询失败\n\n📋 订单号：\`${orderId}\`\n\n请稍后再试。`;
        }

        return '';
    }
}
