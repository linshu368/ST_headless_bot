/**
 * RequestTimer - 请求级性能水瀑计时器
 *
 * 在首响关键路径上打戳，最终输出一条结构化 waterfall 日志。
 * 每个 mark 的值 = 距上一个 mark 的毫秒差，直观呈现各段耗时。
 *
 * @example
 * const timer = new RequestTimer();
 * // ... 业务代码 ...
 * timer.mark('placeholder_sent');
 * // ... 业务代码 ...
 * timer.mark('session_resolved');
 * console.log(timer.toWaterfall());
 * // { placeholder_sent: 180, session_resolved: 320, total: 500 }
 */
export class RequestTimer {
    private readonly t0: number;
    private marks: [string, number][] = [];

    constructor() {
        this.t0 = Date.now();
    }

    mark(name: string): void {
        this.marks.push([name, Date.now()]);
    }

    toWaterfall(): Record<string, number> {
        const result: Record<string, number> = {};
        let prev = this.t0;

        for (const [name, time] of this.marks) {
            result[name] = time - prev;
            prev = time;
        }

        if (this.marks.length > 0) {
            result['total'] = this.marks[this.marks.length - 1][1] - this.t0;
        }

        return result;
    }
}
