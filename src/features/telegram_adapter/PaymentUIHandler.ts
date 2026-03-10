import TelegramBot from 'node-telegram-bot-api';
import { PAYMENT_METHODS, PaymentType } from '../../types/payment.js';
import { getCreditsPlans } from '../payment/domain/rechargeRules.js';
import { runtimeConfig } from '../../infrastructure/runtime_config/RuntimeConfigService.js';
import { renderTemplate } from '../../infrastructure/runtime_config/templateRenderer.js';

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
     * 创建星尘套餐选择键盘（每行一个按钮）
     */
    static async createCreditsPlansKeyboard(paymentType: PaymentType): Promise<TelegramBot.InlineKeyboardMarkup> {
        const plans = await getCreditsPlans();
        const rows: TelegramBot.InlineKeyboardButton[][] = plans.map(plan => ([
            { text: `✨ ${plan.credits} 星尘`, callback_data: `pay_amount:${plan.priceCNY}:${paymentType}` }
        ]));

        rows.push([{ text: '🔙 返回选择支付方式', callback_data: 'pay_back' }]);

        return { inline_keyboard: rows };
    }

    /**
     * 套餐图片消息的 caption
     */
    static getCreditsSelectionCaption(): string {
        return `
━━━━━━━━━━━━
`;
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
    static async getRechargeWelcomeMessage(): Promise<string> {
        return runtimeConfig.getPaymentTemplate('payment_recharge_welcome');
    }

    /**
     * 获取订单创建成功消息
     */
    static async getOrderCreatedMessage(
        orderId: string,
        amount: number,
        paymentType: PaymentType
    ): Promise<string> {
        const template = await runtimeConfig.getPaymentTemplate('payment_order_created');
        const methodName = PaymentUIHandler.getPaymentMethodName(paymentType);
        return renderTemplate(template, {
            orderId,
            amount: String(amount),
            methodName,
        });
    }

    /**
     * 获取订单查询结果消息
     */
    static async getOrderStatusMessage(
        orderId: string,
        status: 'paid' | 'pending' | 'expired' | 'failed',
        paymentType?: string,
        amount?: string
    ): Promise<string> {
        const methodName = paymentType ? PaymentUIHandler.getPaymentMethodName(paymentType) : '';

        if (status === 'expired') {
            const template = await runtimeConfig.getPaymentTemplate('payment_order_expired');
            return renderTemplate(template, { orderId });
        }

        if (status === 'pending') {
            const template = await runtimeConfig.getPaymentTemplate('payment_order_pending');
            return renderTemplate(template, {
                orderId,
                methodName,
                amount: amount ?? '',
            });
        }

        if (status === 'failed') {
            const template = await runtimeConfig.getPaymentTemplate('payment_order_failed');
            return renderTemplate(template, { orderId });
        }

        return '';
    }

    /**
     * 获取充值成功通知消息
     */
    static async getPaymentSuccessMessage(
        amount: number,
        orderId: string,
        methodName: string,
        mainCreditsText: string,
        bonusCreditsText: string,
    ): Promise<string> {
        const template = await runtimeConfig.getPaymentTemplate('payment_success');
        return renderTemplate(template, {
            amount: String(amount),
            orderId,
            methodName,
            mainCredits: mainCreditsText,
            bonusLine: bonusCreditsText,
        });
    }
}
