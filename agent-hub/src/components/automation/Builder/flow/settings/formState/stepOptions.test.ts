import { describe, expect, it } from 'vitest';
import { ASK_ONCE_FORM_TYPES, normalizeAskOnce, normalizeRetry } from './stepOptions';

describe('normalizeRetry', () => {
    it('is off for everything that is not an effective retry', () => {
        for (const v of [null, undefined, 0, 'x', [], {}, { max: 0 }, { max: -1 }, { max: 'no' }]) {
            expect(normalizeRetry(v)).toBe(undefined);
        }
    });

    it('always writes both keys, so "no wait" has one spelling', () => {
        expect(normalizeRetry({ max: 2 })).toEqual({ max: 2, backoffMs: 0 });
        expect(normalizeRetry({ max: 2, backoffMs: 0 })).toEqual({ max: 2, backoffMs: 0 });
    });

    it('does NOT clamp a value the editor could not have produced', () => {
        // An AI-built or hand-edited step keeps its number. `retry` has no
        // validator to appeal to (grep automation/validate.js), so a silent
        // clamp here would be the only record that it changed — and the row
        // shows out-of-list values as their own option for the same reason.
        expect(normalizeRetry({ max: 50, backoffMs: 3000 })).toEqual({ max: 50, backoffMs: 3000 });
    });

    it('is idempotent, or an unrelated save would keep rewriting the step', () => {
        const once = normalizeRetry({ max: 3, backoffMs: 1500 });
        expect(normalizeRetry(once)).toEqual(once);
    });
});

describe('normalizeAskOnce — off has one spelling', () => {
    it('every off-ish shape normalises to undefined', () => {
        for (const v of [undefined, null, false, 0, '', 'yes', []]) {
            expect(normalizeAskOnce(v)).toBeUndefined();
        }
    });

    it('an object with nothing recognised in it is still ON', () => {
        // The runner reads `!!step.askOnce`, so `{}` is on. Collapsing it to
        // off here would switch a live setting off on an unrelated save.
        expect(normalizeAskOnce({})).toBe(true);
        expect(normalizeAskOnce({ ttl: 30 })).toBe(true);
        expect(normalizeAskOnce({ acrossRuns: false })).toBe(true);
    });

    it('ttlSeconds rides along un-clamped so the validator can complain', () => {
        expect(normalizeAskOnce({ ttlSeconds: 9000 })).toEqual({ ttlSeconds: 9000 });
        expect(normalizeAskOnce({ acrossRuns: true, ttlSeconds: '60' })).toEqual({ acrossRuns: true, ttlSeconds: 60 });
    });
});

describe('askOnce round-trips on', () => {
    it('is declared as a round-tripping type', () => {
        expect([...ASK_ONCE_FORM_TYPES].sort()).toEqual(['ai_step', 'http_request', 'integration_action']);
    });
});
