import { feishuAlert, AlertType } from './alerts/FeishuAlertService.js';
import { logger } from '../platform/logger.js';

const COMPONENT = 'GlobalErrorHandler';

export function setupGlobalErrorHandlers() {
    process.on('uncaughtException', (error: Error) => {
        logger.error({ kind: 'sys', component: COMPONENT, message: 'Uncaught Exception', error });
        
        feishuAlert.sendP0({
            alertType: AlertType.UNCAUGHT_EXCEPTION,
            message: 'Node.js 进程捕获到未处理的异常，即将退出。服务完全不可用！',
            error: error,
        }).catch(e => logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to send P0 alert', error: e }));

        setTimeout(() => {
            process.exit(1);
        }, 3000);
    });

    process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
        logger.error({ kind: 'sys', component: COMPONENT, message: 'Unhandled Rejection', error: reason });

        feishuAlert.sendP0({
            alertType: AlertType.UNHANDLED_REJECTION,
            message: 'Node.js 进程捕获到未处理的 Promise 拒绝，即将退出。服务完全不可用！',
            error: reason,
        }).catch(e => logger.error({ kind: 'sys', component: COMPONENT, message: 'Failed to send P0 alert', error: e }));

        setTimeout(() => {
            process.exit(1);
        }, 3000);
    });

    logger.info({ kind: 'sys', component: COMPONENT, message: 'Global error handlers initialized' });
}
