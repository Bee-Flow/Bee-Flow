/**
 * The reporter's job is to send the first report and drop the rest.
 *
 * A crash that repeats every frame is the common case, not the exotic one — a
 * bad render throws, the boundary resets, it throws again. Without a limiter
 * that is a sustained POST flood at the customer's own server, from a device
 * whose owner is already having a bad time.
 */

import { _resetReporter, shouldSend } from './report';

const T0 = Date.parse('2026-08-30T09:00:00.000Z');

beforeEach(() => {
    _resetReporter();
});

describe('shouldSend', () => {
    it('sends the first report', () => {
        expect(shouldSend('a', T0)).toBe(true);
    });

    it('drops a repeat of the same crash forever', () => {
        expect(shouldSend('a', T0)).toBe(true);
        expect(shouldSend('a', T0 + 60_000)).toBe(false);
        expect(shouldSend('a', T0 + 3_600_000)).toBe(false);
    });

    it('drops a different crash that arrives too soon after the last', () => {
        expect(shouldSend('a', T0)).toBe(true);
        expect(shouldSend('b', T0 + 100)).toBe(false);
        expect(shouldSend('b', T0 + 6_000)).toBe(true);
    });

    it('stops after the session cap, however far apart they are', () => {
        for (let i = 0; i < 12; i++) {
            expect(shouldSend(`crash-${i}`, T0 + i * 10_000)).toBe(true);
        }
        expect(shouldSend('crash-12', T0 + 10 * 60_000)).toBe(false);
    });
});
