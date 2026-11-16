import { describe, expect, it } from 'vitest';
import { acceptFrameEvent, createEventGate, EVENT_RATE_MAX, EVENT_RATE_WINDOW_MS, EVENT_VALUE_MAX_BYTES } from './frameEvents';

const WIRED = { pick: 'act_pick000001' };
const message = (event: unknown, value?: unknown) => ({ type: 'bf-react-event', event, value });

describe('acceptFrameEvent', () => {
    it('accepts a wired event with a JSON value and names its action', () => {
        expect(acceptFrameEvent(message('pick', { id: 3 }), WIRED)).toEqual({ event: 'pick', actionId: 'act_pick000001', value: { id: 3 } });
        expect(acceptFrameEvent(message('pick'), WIRED)).toEqual({ event: 'pick', actionId: 'act_pick000001', value: null });
    });

    it('ignores an event the block did not wire, inherited names included', () => {
        expect(acceptFrameEvent(message('delete'), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('__proto__'), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('toString'), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('constructor'), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('pick'), { pick: '' })).toBeNull();
    });

    it('ignores anything that is not an event message', () => {
        expect(acceptFrameEvent(null, WIRED)).toBeNull();
        expect(acceptFrameEvent('pick', WIRED)).toBeNull();
        expect(acceptFrameEvent({ type: 'bf-react-resize', event: 'pick' }, WIRED)).toBeNull();
        expect(acceptFrameEvent(message(42), WIRED)).toBeNull();
    });

    it('drops a value above the size cap, and one that is not JSON', () => {
        const big = 'x'.repeat(EVENT_VALUE_MAX_BYTES);
        expect(acceptFrameEvent(message('pick', big), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('pick', big.slice(0, EVENT_VALUE_MAX_BYTES - 10)), WIRED)).not.toBeNull();
        expect(acceptFrameEvent(message('pick', 'é'.repeat(EVENT_VALUE_MAX_BYTES / 2)), WIRED)).toBeNull();
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        expect(acceptFrameEvent(message('pick', loop), WIRED)).toBeNull();
        expect(acceptFrameEvent(message('pick', 10n), WIRED)).toBeNull();
    });
});

describe('createEventGate', () => {
    it('lets a burst through up to the cap per window', () => {
        let t = 0;
        const gate = createEventGate(() => t);
        const results = Array.from({ length: EVENT_RATE_MAX + 2 }, () => gate());
        expect(results.filter(Boolean)).toHaveLength(EVENT_RATE_MAX);
        t += EVENT_RATE_WINDOW_MS;
        expect(gate()).toBe(true);
    });
});
