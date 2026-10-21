// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extractFormState, buildPatch, deepEqual } from './formState';

/**
 * A form page's "Only show this page when…" condition goes out to the server
 * and comes back. extractFormState and buildPatch are per-type allow-lists, so
 * a key missing from either makes the save look clean and drops the value on
 * the next open; `wouldSend` is flushNow's own comparison.
 */
function wouldSend(step: Record<string, unknown>, draft: Record<string, unknown>) {
    const baseline = extractFormState(step);
    return !deepEqual(buildPatch(step, draft), buildPatch(step, baseline));
}

const PAGE = { id: 'p1', type: 'form_page', label: 'More', mode: 'input', form: { title: 'More', fields: [] }, waitSeconds: 3600 };

describe('form_page when', () => {
    it('reaches the draft as an empty string when the page is always shown', () => {
        expect(extractFormState(PAGE).when).toBe('');
        expect(extractFormState({ ...PAGE, when: null }).when).toBe('');
    });

    it('reads a stored condition into the draft and writes a change to it', () => {
        const step = { ...PAGE, when: 'steps.check.output.ok == true' };
        const draft = extractFormState(step);
        expect(draft.when).toBe('steps.check.output.ok == true');
        // Unchanged, so not part of the patch (the patch carries only what changed).
        expect(buildPatch(step, draft)).not.toHaveProperty('when');
        expect(buildPatch(step, { ...draft, when: 'steps.check.output.ok == false' }).when).toBe('steps.check.output.ok == false');
    });

    it('trims the condition and keeps at most 2000 characters', () => {
        expect(buildPatch(PAGE, { ...extractFormState(PAGE), when: '  trigger.output.x > 1  ' }).when).toBe('trigger.output.x > 1');
        const long = `trigger.output.x == "${'a'.repeat(2100)}"`;
        expect((buildPatch(PAGE, { ...extractFormState(PAGE), when: long }).when as string).length).toBe(2000);
    });

    it('writes a cleared condition as null, like the server does', () => {
        const stored = { ...PAGE, when: 'vars.n > 0' };
        expect(buildPatch(stored, { ...extractFormState(stored), when: '' }).when).toBeNull();
        expect(buildPatch(stored, { ...extractFormState(stored), when: '   ' }).when).toBeNull();
    });

    it('sends nothing for a page that never had a condition', () => {
        expect(buildPatch(PAGE, extractFormState(PAGE))).not.toHaveProperty('when');
        expect(buildPatch(PAGE, { ...extractFormState(PAGE), when: '' })).not.toHaveProperty('when');
    });

    it('counts as a change to send only when the condition changed', () => {
        const draft = extractFormState(PAGE);
        expect(wouldSend(PAGE, draft)).toBe(false);
        expect(wouldSend(PAGE, { ...draft, when: 'vars.n > 0' })).toBe(true);
        const stored = { ...PAGE, when: 'vars.n > 0' };
        expect(wouldSend(stored, { ...extractFormState(stored), when: '' })).toBe(true);
    });

    it('applies to a closing page too', () => {
        const ending = { ...PAGE, mode: 'ending', waitSeconds: undefined, when: 'trigger.output.done == true' };
        const draft = extractFormState(ending);
        expect(draft.when).toBe('trigger.output.done == true');
        expect(buildPatch(ending, { ...draft, when: 'trigger.output.done == false' }).when).toBe('trigger.output.done == false');
    });
});
