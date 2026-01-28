export interface StreamScheduleState {
    textLength: number;
    hasFirstUpdate: boolean;
    lastUpdateAtMs: number | null;
}

export interface StreamScheduleDecision {
    shouldUpdate: boolean;
    isFirstUpdate: boolean;
}

export const STREAMING_FIRST_UPDATE_CHARS = 5;
export const STREAMING_REGULAR_UPDATE_INTERVAL_MS = 2000;

export const createInitialStreamScheduleState = (): StreamScheduleState => ({
    textLength: 0,
    hasFirstUpdate: false,
    lastUpdateAtMs: null,
});

export const applyStreamChar = (
    state: StreamScheduleState,
    nowMs: number
): { nextState: StreamScheduleState; decision: StreamScheduleDecision | null } => {
    const nextLength = state.textLength + 1;

    if (!state.hasFirstUpdate && nextLength >= STREAMING_FIRST_UPDATE_CHARS) {
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
        if (nowMs - state.lastUpdateAtMs >= STREAMING_REGULAR_UPDATE_INTERVAL_MS) {
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
