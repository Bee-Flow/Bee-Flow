/**
 * The AI step's reliability settings (answer checks, fallback, temperature,
 * "reuse the answer") and forEach.concurrency round-trip on the phone exactly
 * as on the web (agent-hub `flow/settings/aiStepReliability/reliabilityModel.ts`
 * and `formState/stepOptions.ts`). A save on the phone must not drop what was
 * set on the web or through MCP.
 */

import { buildPatch, extractFormState } from './index';
import { BUILDER, requireWeb } from '../bindings/testing/web';
import type { FlowNode } from '../bindings/types';

const web = requireWeb(`${BUILDER}/flow/settings/formState`);

const FULL = {
    id: 'ai', type: 'ai_step', prompt: 'p', temperature: 0.7,
    enumFrom: [{ field: 'category', ref: 'steps.a.output.names', ignoreCase: false, allowEmpty: true }],
    checks: [
        { kind: 'numbersFrom', field: 'total', ref: 'steps.a.output.text', tolerance: 0.5, percent: false },
        { kind: 'script', field: 'summary', script: 'latin', minRatio: 0.8 },
        { kind: 'items', field: 'rows', minItems: 1, sameCountAs: 'tags' },
        { kind: 'bogus' },
    ],
    fallback: { kind: 'value', fields: { summary: { kind: 'literal', value: 'n/a' } } },
    askOnce: { acrossRuns: true, ttlSeconds: 600 },
    forEach: { overRef: 'steps.a.output.items', itemVar: 'item', maxIterations: 50, concurrency: 4 },
} as unknown as FlowNode;

const PLAIN = { id: 'ai2', type: 'ai_step', prompt: 'p' } as unknown as FlowNode;
const FAIL = { id: 'ai3', type: 'ai_step', checks: [{ kind: 'items', field: 'rows' }], fallback: { kind: 'fail' } } as unknown as FlowNode;

describe('ai_step reliability round-trip', () => {
    it.each([['full', FULL], ['plain', PLAIN], ['explicit fail', FAIL]])('%s extracts and patches like the web', (_n, step) => {
        const draft = extractFormState(step);
        expect(draft).toStrictEqual(web.extractFormState?.(step));
        expect(buildPatch(step, draft)).toStrictEqual(web.buildPatch?.(step, draft));
    });

    it('keeps forEach.concurrency when another forEach setting changes, and drops nothing on an untouched save', () => {
        const base = extractFormState(FULL);
        const untouched = buildPatch(FULL, base);
        for (const key of ['forEach', 'enumFrom', 'fallback', 'askOnce', 'temperature']) expect(untouched).not.toHaveProperty(key);
        const edited = { ...base, forEach: { ...(base.forEach as object), maxIterations: 60 } };
        const patch = buildPatch(FULL, edited) as { forEach: Record<string, unknown> };
        expect(patch.forEach).toStrictEqual({ overRef: 'steps.a.output.items', itemVar: 'item', maxIterations: 60, concurrency: 4 });
    });

    it('writes an edited check list in its stored shape', () => {
        const base = extractFormState(FULL);
        const edited = { ...base, checks: [{ kind: 'script', field: 'summary', script: 'latin', minRatio: '1' }], temperature: 0.2 };
        const patch = buildPatch(FULL, edited) as Record<string, unknown>;
        expect(patch.checks).toStrictEqual([{ kind: 'script', field: 'summary', script: 'latin' }]);
        expect(patch.temperature).toBe(0.2);
    });

    it('clears what the author removes, and writes nothing for an untouched plain step', () => {
        const draft = { ...extractFormState(FULL), checks: [], enumFrom: [], fallback: null, temperature: null, askOnce: undefined };
        const patch = buildPatch(FULL, draft) as Record<string, unknown>;
        for (const key of ['checks', 'enumFrom', 'fallback', 'temperature', 'askOnce']) {
            expect(key in patch && patch[key] === undefined).toBe(true);
        }
        expect(buildPatch(PLAIN, extractFormState(PLAIN))).toStrictEqual(web.buildPatch?.(PLAIN, extractFormState(PLAIN)));
    });

    it('writes forEach.concurrency as the author typed it, and none when empty', () => {
        const withNumber = { ...extractFormState(FULL), forEach: { overRef: 'x', concurrency: '7' } };
        expect((buildPatch(FULL, withNumber) as { forEach: { concurrency?: number } }).forEach.concurrency).toBe(7);
        const empty = { ...extractFormState(FULL), forEach: { overRef: 'x', concurrency: '' } };
        expect('concurrency' in (buildPatch(FULL, empty) as { forEach: object }).forEach).toBe(false);
    });
});
