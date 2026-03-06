/**
 * 支付服务入口 (独立 Service)
 * 
 * 职责边界（纯网关）：
 * 1. 接收第三方支付平台的异步回调
 * 2. 验证签名
 * 3. 将合法的支付事件转发给 Bot Service（由 Bot 负责积分入账 + 通知用户）
 * 4. 提供支付完成跳转页
 * 
 * 不涉及：积分计算、数据库写入、Telegram 消息发送
 * 
 * 部署：作为独立的 Railway Service 运行
 */

import express, { Request, Response } from 'express';
import axios from 'axios';
import { JLPaymentGateway } from '../infrastructure/payment/JLPaymentGateway.js';
import type { PaymentNotifyData, InternalPaymentEvent } from '../types/payment.js';
import { logger } from '../platform/logger.js';

const COMPONENT = 'PaymentService';

const requiredEnvVars = [
    'PAYMENT_MERCHANT_ID',
    'PAYMENT_MERCHANT_KEY',
    'PAYMENT_NOTIFY_URL',
    'BOT_SERVICE_URL',
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        logger.error({ kind: 'sys', component: COMPONENT, message: `Missing required env var: ${envVar}` });
        process.exit(1);
    }
}

const paymentGateway = new JLPaymentGateway({
    merchantId: process.env.PAYMENT_MERCHANT_ID!,
    merchantKey: process.env.PAYMENT_MERCHANT_KEY!,
    baseUrl: process.env.PAYMENT_BASE_URL || 'http://jlusdt.com',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL!,
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
});

const botServiceUrl = process.env.BOT_SERVICE_URL!;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 健康检查
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        service: 'payment-service',
        timestamp: new Date().toISOString()
    });
});

// 支付异步回调（第三方 → 本服务 → Bot Service）
app.post('/payment/notify', async (req: Request, res: Response) => {
    const notifyData = req.body as PaymentNotifyData;
    const traceId = `notify:${notifyData.out_trade_no || Date.now()}`;

    logger.info({
        kind: 'infra', component: COMPONENT,
        message: 'Payment callback received',
        meta: { traceId, orderId: notifyData.out_trade_no, status: notifyData.trade_status }
    });

    try {
        // 1. 验证签名
        if (!paymentGateway.verifyNotifySign(notifyData)) {
            logger.warn({ kind: 'infra', component: COMPONENT, message: 'Invalid signature', meta: { traceId } });
            res.status(400).send('fail');
            return;
        }

        // 2. 仅处理支付成功的回调
        if (notifyData.trade_status === 'TRADE_SUCCESS') {
            const userId = notifyData.param || '';
            const orderId = notifyData.out_trade_no;
            const amount = notifyData.total_fee;
            const paymentType = notifyData.type || 'unknown';

            if (!userId) {
                logger.error({ kind: 'biz', component: COMPONENT, message: 'Missing userId in callback', meta: { traceId, orderId } });
                res.send('success');
                return;
            }

            // 3. 转发给 Bot Service 处理业务逻辑
            const event: InternalPaymentEvent = { userId, orderId, amount, paymentType };

            try {
                await axios.post(`${botServiceUrl}/internal/payment-callback`, event, {
                    timeout: 10000,
                    headers: { 'Content-Type': 'application/json' },
                });
                logger.info({
                    kind: 'biz', component: COMPONENT,
                    message: 'Payment event forwarded to Bot Service',
                    meta: { traceId, userId, orderId }
                });
            } catch (forwardError) {
                logger.error({
                    kind: 'sys', component: COMPONENT,
                    message: 'Failed to forward payment event to Bot Service',
                    error: forwardError, meta: { traceId, userId, orderId }
                });
            }
        }

        res.send('success');
    } catch (error) {
        logger.error({ kind: 'sys', component: COMPONENT, message: 'Callback processing error', error, meta: { traceId } });
        res.status(500).send('error');
    }
});

// 支付完成跳转页
app.get('/payment/return', (req: Request, res: Response) => {
    const orderId = req.query.out_trade_no || '';

    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>支付完成</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 400px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
            font-size: 40px;
        }
        h2 { color: #333; margin-bottom: 15px; }
        p { color: #666; line-height: 1.6; margin-bottom: 10px; }
        .order-id {
            background: #f5f5f5;
            padding: 10px 20px;
            border-radius: 10px;
            font-family: monospace;
            font-size: 12px;
            color: #888;
            margin: 20px 0;
            word-break: break-all;
        }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 25px;
            font-weight: 600;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h2>支付处理完成</h2>
        <p>您的支付正在处理中</p>
        <p>请返回 Telegram 查看充值结果</p>
        ${orderId ? `<div class="order-id">订单号: ${orderId}</div>` : ''}
        <a href="https://t.me" class="btn">返回 Telegram</a>
    </div>
</body>
</html>
    `);
});

// 404
app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
});

// 启动服务
const port = parseInt(process.env.PAYMENT_PORT || '3000', 10);

app.listen(port, () => {
    logger.info({
        kind: 'sys', component: COMPONENT,
        message: `Payment service started on port ${port}`,
        meta: { notifyUrl: process.env.PAYMENT_NOTIFY_URL, botServiceUrl }
    });
});

// 优雅退出
process.on('SIGINT', () => {
    logger.info({ kind: 'sys', component: COMPONENT, message: 'Shutting down...' });
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info({ kind: 'sys', component: COMPONENT, message: 'Shutting down...' });
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error({ kind: 'sys', component: COMPONENT, message: 'Uncaught exception', error });
});

process.on('unhandledRejection', (reason) => {
    logger.error({ kind: 'sys', component: COMPONENT, message: 'Unhandled rejection', error: reason });
});
