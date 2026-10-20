// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPatch, deepEqual, extractFormState } from './formState';

/**
 * The SAVE round-trip of the AI step's reliability settings. The editor can
 * show a control that buildPatch silently drops (it has happened with askOnce
 * and forEach), so every test here goes through extractFormState + buildPatch
 * and the same comparison flushNow makes before it sends anything.
 */
const wouldSave = (step: Record<string, unknown>, draft: Record<string, unknown>, baseline: Record<string, unknown>) =>
    !deepEqual(buildPatch(step, draft), buildPatch(step, baseline));
// The wire: the patch is merged into the step, then JSON drops every undefined.
const afterSave = (step: Record<string, unknown>, patch: Record<string, unknown>) =>
    JSON.parse(JSON.stringify({ ...step, ...patch, id: step.id }));

const stepOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 's1', type: 'ai_step', prompt: 'Sort this', modelTier: 'auto', allowTools: false, ...over,
});

const CONFIGURED = {
    temperature: 0,
    askOnce: { acrossRuns: true },
    outputSchema: { type: 'object', properties: { category: { type: 'string' }, summary: { type: 'string' }, rows: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } },
    enumFrom: [{ field: 'category', ref: 'steps.s0.output.rows', value: 'name' }],
    checks: [
        { kind: 'numbersFrom', field: 'summary', ref: 'steps.s0.output.text', tolerance: 0.5 },
        { kind: 'script', field: 'summary', script: 'latin' },
        { kind: 'items', field: 'rows', minItems: 1, sameCountAs: 'steps.s0.output.rows' },
    ],
    fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } },
};

describe('an untouched step', () => {
    it('without any of the settings adds none of their keys to the patch', () => {
        const step = stepOf();
        const patch = buildPatch(step, extractFormState(step));
        for (const key of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) expect(patch).not.toHaveProperty(key);
    });

    it('with all of them comes back exactly as it was', () => {
        const step = stepOf(CONFIGURED);
        const patch = buildPatch(step, extractFormState(step));
        const saved = afterSave(step, patch);
        for (const key of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) expect(saved[key]).toEqual(CONFIGURED[key as keyof typeof CONFIGURED]);
    });

    it('is not worth saving', () => {
        const step = stepOf(CONFIGURED);
        const baseline = extractFormState(step);
        expect(wouldSave(step, baseline, baseline)).toBe(false);
    });
});

describe('editing', () => {
    it('a new check reaches the server and comes back', () => {
        const step = stepOf({ outputSchema: CONFIGURED.outputSchema });
        const baseline = extractFormState(step);
        const draft = { ...baseline, checks: [{ kind: 'items', field: 'rows', minItems: 2 }] };
        expect(wouldSave(step, draft, baseline)).toBe(true);
        expect(extractFormState(afterSave(step, buildPatch(step, draft))).checks).toEqual([{ kind: 'items', field: 'rows', minItems: 2 }]);
    });

    it('moving a list between "shown to the AI" and "checked afterwards" is a save', () => {
        const step = stepOf({ enumFrom: CONFIGURED.enumFrom });
        const baseline = extractFormState(step);
        const entry = baseline.enumFrom[0];
        const draft = { ...baseline, enumFrom: [], checks: [{ kind: 'allowedFrom', ...entry }] };
        expect(wouldSave(step, draft, baseline)).toBe(true);
        const saved = extractFormState(afterSave(step, buildPatch(step, draft)));
        expect(saved.enumFrom).toEqual([]);
        expect(saved.checks).toEqual([{ kind: 'allowedFrom', field: 'category', ref: 'steps.s0.output.rows', value: 'name' }]);
    });

    it('the fallback values and the temperature survive the trip', () => {
        const step = stepOf({ checks: CONFIGURED.checks });
        const baseline = extractFormState(step);
        const draft = { ...baseline, temperature: 0.7, fallback: { kind: 'value', fields: { summary: { kind: 'template', value: 'Failed for {{trigger.output.id}}' } } } };
        const back = extractFormState(afterSave(step, buildPatch(step, draft)));
        expect(back.temperature).toBe(0.7);
        expect(back.fallback).toEqual({ kind: 'value', fields: { summary: { kind: 'template', value: 'Failed for {{trigger.output.id}}' } } });
    });

    it('"reuse the answer" round-trips on an AI step, as a tick and as "for later runs too"', () => {
        const step = stepOf();
        const baseline = extractFormState(step);
        expect(baseline.askOnce).toBeUndefined();
        const ticked = { ...baseline, askOnce: true };
        expect(wouldSave(step, ticked, baseline)).toBe(true);
        expect(extractFormState(afterSave(step, buildPatch(step, ticked))).askOnce).toBe(true);
        const wider = { ...baseline, askOnce: { acrossRuns: true } };
        expect(extractFormState(afterSave(step, buildPatch(step, wider))).askOnce).toEqual({ acrossRuns: true });
    });
});

describe('clearing', () => {
    it('removes every key from the saved step', () => {
        const step = stepOf(CONFIGURED);
        const baseline = extractFormState(step);
        const draft = { ...baseline, temperature: null, askOnce: undefined, enumFrom: [], checks: [], fallback: { kind: 'fail' } };
        expect(wouldSave(step, draft, baseline)).toBe(true);
        const saved = afterSave(step, buildPatch(step, draft));
        for (const key of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) expect(saved).not.toHaveProperty(key);
    });
});

describe('"items at the same time" (forEach.concurrency)', () => {
    const forEach = { overRef: 'steps.s0.output.rows', itemVar: 'item', maxIterations: 50, concurrency: 8 };

    it.each([
        ['ai_step', stepOf({ forEach })],
        ['data_extraction', { id: 'x1', type: 'data_extraction', source: { kind: 'ref', path: 'trigger.output.text' }, fields: [{ name: 'total', type: 'number' }], forEach }],
    ])('survives the form on %s', (_type, step) => {
        // The patch carries only what changed, so "nothing dropped" is read off the saved step.
        expect(afterSave(step, buildPatch(step, extractFormState(step))).forEach).toEqual(forEach);
    });

    it('is written when typed, and left out when emptied', () => {
        const step = stepOf({ forEach: { ...forEach, concurrency: undefined } });
        const baseline = extractFormState(step);
        const typed = { ...baseline, forEach: { ...baseline.forEach, concurrency: 6 } };
        expect(afterSave(step, buildPatch(step, typed)).forEach.concurrency).toBe(6);
        const emptied = { ...extractFormState(stepOf({ forEach })), forEach: { ...forEach, concurrency: undefined } };
        expect(afterSave(stepOf({ forEach }), buildPatch(stepOf({ forEach }), emptied)).forEach).not.toHaveProperty('concurrency');
    });

    it('is not clamped: the validator tells the author about a wrong number', () => {
        const step = stepOf({ forEach: { overRef: 'a', itemVar: 'item', maxIterations: 5 } });
        const draft = { ...extractFormState(step), forEach: { overRef: 'a', itemVar: 'item', maxIterations: 5, concurrency: 5000 } };
        expect(afterSave(step, buildPatch(step, draft)).forEach.concurrency).toBe(5000);
    });
});
