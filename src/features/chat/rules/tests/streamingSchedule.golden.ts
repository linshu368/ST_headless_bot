import assert from 'node:assert/strict';
import {
    applyStreamChar,
    createInitialStreamScheduleState,
    STREAMING_FIRST_UPDATE_CHARS,
    STREAMING_REGULAR_UPDATE_INTERVAL_MS,
} from '../streamingSchedule.js';

type UpdatePoint = {
    index: number;
    text: string;
    isFirst: boolean;
    atMs: number;
};

const feed = (input: string, times: number[]) => {
    let state = createInitialStreamScheduleState();
    const updates: UpdatePoint[] = [];

    for (let i = 0; i < input.length; i += 1) {
        const nowMs = times[i];
        const { nextState, decision } = applyStreamChar(state, nowMs);
        state = nextState;

        if (decision?.shouldUpdate) {
            updates.push({
                index: i,
                text: input.slice(0, i + 1),
                isFirst: decision.isFirstUpdate,
                atMs: nowMs,
            });
        }
    }

    return updates;
};

const testFirstUpdateAtFiveChars = () => {
    const input = 'hello world';
    const times = input.split('').map((_, i) => i * 100);
    const updates = feed(input, times);

    assert.equal(updates.length >= 1, true, 'should emit at least one update');
    assert.equal(updates[0].text.length, STREAMING_FIRST_UPDATE_CHARS, 'first update at 5 chars');
    assert.equal(updates[0].isFirst, true, 'first update flagged');
};

const testRegularIntervalUpdates = () => {
    const input = 'abcdefghijklmnopqrstuvwxyz';
    const times = input.split('').map((_, i) => i * 100); // 100ms per char
    const updates = feed(input, times);

    const first = updates[0];
    const second = updates[1];
    assert.ok(first, 'first update missing');
    assert.ok(second, 'second update missing');

    const delta = second.atMs - first.atMs;
    assert.equal(
        delta >= STREAMING_REGULAR_UPDATE_INTERVAL_MS,
        true,
        'regular update should occur after interval'
    );
};

const testNoRegularUpdateBeforeInterval = () => {
    const input = 'abcdefghijklmnop';
    const times = input.split('').map((_, i) => i * 300); // 300ms per char
    const updates = feed(input, times);

    assert.ok(updates[0], 'first update missing');
    if (updates[1]) {
        const delta = updates[1].atMs - updates[0].atMs;
        assert.equal(
            delta >= STREAMING_REGULAR_UPDATE_INTERVAL_MS,
            true,
            'should not update before interval'
        );
    }
};

const run = () => {
    testFirstUpdateAtFiveChars();
    testRegularIntervalUpdates();
    testNoRegularUpdateBeforeInterval();
    console.log('streamingSchedule.golden: OK');
};

run();
