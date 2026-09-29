// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
    extractFormState, buildPatch, deepEqual, normalizeAskOnce, ASK_ONCE_FORM_TYPES,
} from './formState';

/**
 * The SAVE round-trip for "ask this app only once per run".
 *
 * actionEditors.askOnce.test.jsx renders the toggle against a synthetic draft
 * and asserts what `set` is called with. It passes whether or not the field
 * is ever persisted — and for the whole life of the feature it was not:
 * `askOnce` appeared in neither extractFormState nor buildPatch, so
 * SettingsForm.flushNow compared `buildPatch(step, draft)` against
 * `buildPatch(step, baseline)`, found them equal because NEITHER contained
 * the field, advanced its baseline locally and returned without calling
 * onPatch. The user ticked the box, the panel showed it ticked, no error
 * appeared, nothing reached the server, and reopening the node showed it off.
 *
 * That comparison is therefore what every test below asserts against
 * directly. A test that only checks "buildPatch contains askOnce" would go
 * green on a patch flushNow still swallows.
 */

// Exactly the test flushNow makes before deciding there is nothing to send.
const wouldSave = (step, draft, baseline) =>
    !deepEqual(buildPatch(step, draft), buildPatch(step, baseline));

// The wire: NodeDetailView merges the patch into the step, then the whole
// definition is JSON.stringify'd for the PUT — which is how an `undefined`
// in a patch removes a key.
const afterSave = (step, patch) => JSON.parse(JSON.stringify({ ...step, ...patch, id: step.id }));

const stepOf = (over = {}) => ({
    id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {}, ...over,
});

describe('ticking the box reaches the server', () => {
    it('a tick builds a patch flushNow will send, and comes back ticked', () => {
        const step = stepOf();
        const baseline = extractFormState(step);
        expect(baseline.askOnce).toBeUndefined();

        const draft = { ...baseline, askOnce: true };
        expect(wouldSave(step, draft, baseline)).toBe(true);

        const patch = buildPatch(step, draft);
        expect(patch.askOnce).toBe(true);
        expect(extractFormState(afterSave(step, patch)).askOnce).toBe(true);
    });

    it('"…and keep the answer for later runs" survives the same trip', () => {
        const step = stepOf({ askOnce: true });
        const baseline = extractFormState(step);
        const draft = { ...baseline, askOnce: { acrossRuns: true } };
        expect(wouldSave(step, draft, baseline)).toBe(true);

        const patch = buildPatch(step, draft);
        expect(extractFormState(afterSave(step, patch)).askOnce).toEqual({ acrossRuns: true });
    });

    it('dropping back to the plain tick is a save too', () => {
        const step = stepOf({ askOnce: { acrossRuns: true } });
        const baseline = extractFormState(step);
        const draft = { ...baseline, askOnce: true };
        expect(wouldSave(step, draft, baseline)).toBe(true);
        expect(extractFormState(afterSave(step, buildPatch(step, draft))).askOnce).toBe(true);
    });
});

describe('unticking clears it — the toggle must not save on and never off', () => {
    it('an untick sends a patch that REMOVES the field', () => {
        const step = stepOf({ askOnce: true });
        const baseline = extractFormState(step);
        expect(baseline.askOnce).toBe(true);

        const draft = { ...baseline, askOnce: undefined };
        expect(wouldSave(step, draft, baseline)).toBe(true);

        const patch = buildPatch(step, draft);
        // undefined, never null: the validator's guard is
        // `askOnce !== undefined && askOnce !== false`, so a null would be read
        // as ON and error a write step whose setting is off.
        expect('askOnce' in patch).toBe(true);
        expect(patch.askOnce).toBeUndefined();

        const saved = afterSave(step, patch);
        expect('askOnce' in saved).toBe(false);
        expect(extractFormState(saved).askOnce).toBeUndefined();
    });

    it('unticking the wider promise clears the whole field', () => {
        const step = stepOf({ askOnce: { acrossRuns: true, ttlSeconds: 60 } });
        const draft = { ...extractFormState(step), askOnce: undefined };
        expect('askOnce' in afterSave(step, buildPatch(step, draft))).toBe(false);
    });
});

describe('off has one spelling, and an unrelated save does not rewrite it', () => {
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

    it('renaming the label on a ticked step leaves askOnce alone', () => {
        const step = stepOf({ askOnce: { acrossRuns: true } });
        const baseline = extractFormState(step);
        const patch = buildPatch(step, { ...baseline, label: 'Look up the invoice' });
        expect('askOnce' in patch).toBe(false);
    });

    it('renaming a step that stores askOnce:false does not strip the false', () => {
        // Semantically inert either way, but a save that rewrites a field the
        // user did not touch is a diff nobody can explain.
        const step = stepOf({ askOnce: false });
        const patch = buildPatch(step, { ...extractFormState(step), label: 'Renamed' });
        expect('askOnce' in patch).toBe(false);
    });
});

describe('http_request round-trips it too', () => {
    // No editor writes it there yet (that is the caching work), but an
    // imported or hand-edited definition can already carry one and the form
    // must not be what deletes it.
    const httpStep = (over = {}) => ({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', ...over });

    it('is declared as a round-tripping type', () => {
        expect([...ASK_ONCE_FORM_TYPES].sort()).toEqual(['http_request', 'integration_action']);
    });

    it('an existing askOnce survives an unrelated save', () => {
        const step = httpStep({ askOnce: { acrossRuns: true } });
        expect(extractFormState(step).askOnce).toEqual({ acrossRuns: true });
        const patch = buildPatch(step, { ...extractFormState(step), timeoutMs: 20000 });
        expect('askOnce' in patch).toBe(false);
        expect(extractFormState(afterSave(step, patch)).askOnce).toEqual({ acrossRuns: true });
    });

    it('a tick would be sent', () => {
        const step = httpStep();
        const baseline = extractFormState(step);
        expect(wouldSave(step, { ...baseline, askOnce: true }, baseline)).toBe(true);
    });
});
