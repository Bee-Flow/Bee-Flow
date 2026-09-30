/**
 * The small rules around the editor: how an AI proposal lands in a draft,
 * what the Test tab may claim, which apps a skill may be granted.
 */

import { applyProposal, isBlankDraft } from './aiDraft';
import { availableApps, toggleId } from './apps';
import { draftOf } from './skillModel';
import { adviceRef, refHref, stepStatus, testErrorMessage } from './testRun';
import type { TestRun } from './types';

const t = (_key: string, fallback: string) => fallback;

describe('applyProposal', () => {
    const base = draftOf({ name: 'Mine', description: 'Kept', instructions: '', icon: '🧠', steps: [{ id: 'old', text: 'x' }] });

    it('takes the facets the model answered, normalised, and keeps the rest', () => {
        const next = applyProposal(base, { name: '', instructions: 'Use when…', steps: [{ text: 'Look up' }, { id: 'b', text: 'Reply', refs: [{ kind: 'bogus', id: 1 }] }] });
        expect(next.name).toBe('Mine');
        expect(next.description).toBe('Kept');
        expect(next.instructions).toBe('Use when…');
        expect(next.icon).toBe('🧠');
        expect(next.steps).toEqual([{ id: 'step_1', text: 'Look up', refs: [] }, { id: 'b', text: 'Reply', refs: [] }]);
        expect(next.rulesV2).toBe(base.rulesV2);
    });

    it('knows a blank draft from one with a method', () => {
        expect(isBlankDraft(draftOf({}))).toBe(true);
        expect(isBlankDraft(base)).toBe(false);
        expect(isBlankDraft(draftOf({ instructions: 'x' }))).toBe(false);
    });
});

describe('the Test tab’s claims', () => {
    it('never draws an unknown status as a pass', () => {
        expect(stepStatus('ok')).toBe('ok');
        expect(stepStatus('error')).toBe('error');
        expect(stepStatus('grand')).toBe('warning');
        expect(stepStatus(undefined)).toBe('warning');
    });

    it('says a cut stream is not a clean run, and passes unknown messages through', () => {
        expect(testErrorMessage(t, 'stream_cut')).toMatch(/stopped before a verdict/);
        expect(testErrorMessage(t, 'no_steps')).toMatch(/Add steps first/);
        expect(testErrorMessage(t, 'whatever', 'Server said no')).toBe('Server said no');
        expect(testErrorMessage(t, undefined)).toBe('Could not run this test.');
    });

    it('points the advice at the first flagged step’s first reference', () => {
        const run: TestRun = {
            id: 'r',
            question: 'q',
            status: 'warning',
            advice: 'check',
            ranAt: null,
            results: [
                { stepId: 'a', title: 'A', evidence: '', status: 'ok' },
                { stepId: 'b', title: 'B', evidence: '', status: 'warning' },
            ],
        };
        const steps = [
            { id: 'a', text: '', refs: [{ kind: 'kb' as const, id: 'kb0' }] },
            { id: 'b', text: '', refs: [{ kind: 'automation' as const, id: 'r 1' }] },
        ];
        const ref = adviceRef(run, steps);
        expect(ref).toEqual({ kind: 'automation', id: 'r 1' });
        expect(refHref(ref!)).toBe('/automations/r%201');
        expect(refHref({ kind: 'table', id: 't' })).toBeNull();
        expect(adviceRef({ ...run, results: [run.results[0]!] }, steps)).toBeNull();
        expect(adviceRef(null, steps)).toBeNull();
    });
});

describe('availableApps — unknown never widens a grant', () => {
    const catalog = [{ id: 'agent-search' }, { id: 'gmail' }, { id: 'slack' }];

    it('offers only the built-ins until the org’s list is known', () => {
        expect(availableApps(catalog, null, false).map((a) => a.id)).toEqual(['agent-search']);
    });

    it('offers everything the org allows, or everything when it restricts nothing', () => {
        expect(availableApps(catalog, ['gmail'], true).map((a) => a.id)).toEqual(['agent-search', 'gmail']);
        expect(availableApps(catalog, null, true)).toHaveLength(3);
    });

    it('toggles an id in and out', () => {
        expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
        expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    });
});
