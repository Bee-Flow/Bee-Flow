// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    extractFormState, buildPatch, deepEqual, normalizeRetry, RETRY_FORM_TYPES,
} from './formState';

/**
 * `retry` goes out to the server and comes back — the half without which the
 * row is decoration.
 *
 * This form has shipped a control that saved nothing twice (datatable's
 * Iteration toggle, C12; integration_action's askOnce tick) and both times
 * the mechanism was the same: extractFormState and buildPatch are per-type
 * allow-lists, so a key missing from either one makes flushNow's comparison
 * — the patch the draft builds vs the patch the BASELINE builds — come out
 * equal, and the server is never called at all. The tick showed, the save
 * looked clean, the value was gone on the next open.
 *
 * So the test that matters here is not "buildPatch returns retry". It is
 * "flushNow would have sent something", which is the comparison reproduced
 * below in `wouldSend`.
 */

/** flushNow's actual test, in one line (SettingsForm.jsx:195). */
function wouldSend(step, draft) {
    const baseline = extractFormState(step);
    return !deepEqual(buildPatch(step, draft), buildPatch(step, baseline));
}

const HTTP = { type: 'http_request', label: 'Fetch', url: 'https://x.nl', method: 'GET' };

describe('the retry field round-trips', () => {
    it('reaches the draft as a KEY, even when the step has no retry', () => {
        // Presence is what the editor reads to decide the row may be shown at
        // all, so "absent" and "off" must be different things in the draft.
        const draft = extractFormState(HTTP);
        expect('retry' in draft).toBe(true);
        expect(draft.retry).toBe(null);
    });

    it('does not reach the draft of a type that does not offer the row', () => {
        expect('retry' in extractFormState({ type: 'set', label: 'A' })).toBe(false);
        expect('retry' in extractFormState({ type: 'trigger', kind: 'manual' })).toBe(false);
    });

    it('a step that already has one opens showing it', () => {
        const draft = extractFormState({ ...HTTP, retry: { max: 3, backoffMs: 2000 } });
        expect(draft.retry).toEqual({ max: 3, backoffMs: 2000 });
    });

    it('TICKING IT ON ACTUALLY SENDS — the whole point', () => {
        const draft = { ...extractFormState(HTTP), retry: { max: 2, backoffMs: 5000 } };
        expect(wouldSend(HTTP, draft)).toBe(true);
        expect(buildPatch(HTTP, draft).retry).toEqual({ max: 2, backoffMs: 5000 });
    });

    it('TICKING IT OFF ACTUALLY SENDS, and clears the key rather than zeroing it', () => {
        // `undefined` drops out of the definition after the patch merge, so
        // off has ONE spelling: absent. A `{ max: 0 }` left behind would be a
        // second spelling, and unticking would build a patch deepEqual to the
        // ticked one — the bug again, in the other direction.
        const step = { ...HTTP, retry: { max: 2, backoffMs: 5000 } };
        const draft = { ...extractFormState(step), retry: null };
        expect(wouldSend(step, draft)).toBe(true);
        const patch = buildPatch(step, draft);
        expect('retry' in patch).toBe(true);
        expect(patch.retry).toBe(undefined);
    });

    it('opening a step and changing something else does not invent a retry', () => {
        const draft = { ...extractFormState(HTTP), label: 'Renamed' };
        expect('retry' in buildPatch(HTTP, draft)).toBe(false);
    });

    it('a step stored as the runner\'s own off is left byte-identical', () => {
        // `{ max: 0 }` already means "do not retry" (execution.js gates on
        // `retry.max > 0`). Rewriting it on an unrelated save would put a
        // definition change in the history that changed nothing.
        const step = { ...HTTP, retry: { max: 0 } };
        const draft = { ...extractFormState(step), label: 'Renamed' };
        expect('retry' in buildPatch(step, draft)).toBe(false);
    });
});

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

describe('every type that offers the row round-trips it', () => {
    it.each([...RETRY_FORM_TYPES])('%s', (type) => {
        const step = { type, label: 'A' };
        expect('retry' in extractFormState(step)).toBe(true);
        const draft = { ...extractFormState(step), retry: { max: 1, backoffMs: 2000 } };
        expect(buildPatch(step, draft).retry).toEqual({ max: 1, backoffMs: 2000 });
    });
});
