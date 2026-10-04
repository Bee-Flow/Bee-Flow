import { describe, it, expect } from 'vitest';
import { classifyRef } from './refTokens';
import { parseValue } from './valueParts';
import { bindingFromInput } from '../../../../utils/bindingHelpers';

/**
 * Inside an expanded flowlet a sub-step's id is namespaced `<callId>/<subId>`
 * (flow/inlineFlowlets.js), so a field mapped there reads
 * `steps.step_f6b2cd68/trg.output.query` until the save strips the prefix. The
 * editor used to read the `/` as a division and showed a "Custom formula" with
 * half a chip in it.
 */
const P = 'steps.step_f6b2cd68/trg.output.query';

describe('a path through a flowlet sub-step', () => {
    it('is a reference to that step, not a formula', () => {
        expect(classifyRef(P)).toEqual(expect.objectContaining({ stepId: 'step_f6b2cd68/trg' }));
        expect(bindingFromInput(P, 'expression')).toEqual({ kind: 'ref', path: P });
    });

    it('reads as one data chip in the value editor', () => {
        const parsed = parseValue({ kind: 'ref', path: P }) as { parts: Array<{ type: string; path?: string }> };
        expect(parsed.parts).toEqual([expect.objectContaining({ type: 'data', path: P })]);
    });

    it('nests: a flowlet inside a flowlet', () => {
        expect(classifyRef('steps.a/b/c.output.x')).toEqual(expect.objectContaining({ stepId: 'a/b/c' }));
    });

    it('a real division after a reference is still a formula', () => {
        expect(bindingFromInput('steps.a.output.total/2', 'expression').kind).toBe('expr');
    });
});
