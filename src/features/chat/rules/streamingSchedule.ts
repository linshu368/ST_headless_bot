export interface StreamScheduleState {
    textLength: number;
    hasFirstUpdate: boolean;
    lastUpdateAtMs: number | null;
}

export interface StreamScheduleDecision {
    shouldUpdate: boolean;
    isFirstUpdate: boolean;
}

export interface StreamScheduleConfig {
    firstUpdateChars: number;
    regularUpdateIntervalSec: number;
}

export const DEFAULT_STREAMING_FIRST_UPDATE_CHARS = 5;
export const DEFAULT_STREAMING_REGULAR_UPDATE_INTERVAL_SEC = 2;

export const createInitialStreamScheduleState = (): StreamScheduleState => ({
    textLength: 0,
    hasFirstUpdate: false,
    lastUpdateAtMs: null,
});

export const applyStreamChar = (
    state: StreamScheduleState,
    nowMs: number,
    scheduleConfig?: StreamScheduleConfig,
): { nextState: StreamScheduleState; decision: StreamScheduleDecision | null } => {
    const firstUpdateChars = scheduleConfig?.firstUpdateChars ?? DEFAULT_STREAMING_FIRST_UPDATE_CHARS;
    const regularIntervalMs = (scheduleConfig?.regularUpdateIntervalSec ?? DEFAULT_STREAMING_REGULAR_UPDATE_INTERVAL_SEC) * 1000;
    const nextLength = state.textLength + 1;

    if (!state.hasFirstUpdate && nextLength >= firstUpdateChars) {
        return {
            nextState: {
                textLength: nextLength,
                hasFirstUpdate: true,
                lastUpdateAtMs: nowMs,
            },
            decision: {
                shouldUpdate: true,
                isFirstUpdate: true,
            },
        };
    }

    if (state.hasFirstUpdate && state.lastUpdateAtMs !== null) {
        if (nowMs - state.lastUpdateAtMs >= regularIntervalMs) {
            return {
                nextState: {
                    textLength: nextLength,
                    hasFirstUpdate: true,
                    lastUpdateAtMs: nowMs,
                },
                decision: {
                    shouldUpdate: true,
                    isFirstUpdate: false,
                },
            };
        }
    }

    return {
        nextState: {
            textLength: nextLength,
            hasFirstUpdate: state.hasFirstUpdate,
            lastUpdateAtMs: state.lastUpdateAtMs,
        },
        decision: null,
    };
};
