// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { extractFormState, buildPatch, deepEqual } from './formState';

/**
 * `images` on ai_step and data_extraction: the SAVE round trip (the same
 * comparison SettingsForm.flushNow makes) and the empty case, which must not
 * write a key onto a step nobody gave images.
 */
const wouldSave = (step: Parameters<typeof buildPatch>[0], draft: Parameters<typeof buildPatch>[1], baseline: Parameters<typeof buildPatch>[1]) =>
    !deepEqual(buildPatch(step, draft), buildPatch(step, baseline));
const afterSave = (step: Record<string, unknown>, patch: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...step, ...patch, id: step.id }));

const HANDLE = { kind: 'ref', path: 'steps.read.output.sourceHandle' };
const STEPS: Array<Record<string, unknown>> = [
    { id: 'a1', type: 'ai_step', prompt: 'What is on it?', inputs: {} },
    { id: 'x1', type: 'data_extraction', source: { kind: 'ref', path: 'steps.read.output.content' }, fields: [{ name: 'total', type: 'number', description: '', required: false }] },
];

describe.each(STEPS)('images on $type', (step) => {
    it('a step without images reads as an empty list and saves no key', () => {
        const draft = extractFormState(step);
        expect(draft.images).toEqual([]);
        expect(afterSave(step, buildPatch(step, draft))).not.toHaveProperty('images');
    });

    it('an added image reaches the server and comes back', () => {
        const baseline = extractFormState(step);
        const draft = { ...baseline, images: [HANDLE] };
        expect(wouldSave(step, draft, baseline)).toBe(true);
        const saved = afterSave(step, buildPatch(step, draft));
        expect(saved.images).toEqual([HANDLE]);
        expect(extractFormState(saved).images).toEqual([HANDLE]);
    });

    it('a blank row (a fresh "Add an image") is not saved', () => {
        const draft = { ...extractFormState(step), images: [{ kind: 'ref', path: '' }] };
        expect(afterSave(step, buildPatch(step, draft))).not.toHaveProperty('images');
    });
});
