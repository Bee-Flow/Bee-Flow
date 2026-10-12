import { describe, expect, it } from 'vitest';
import { buildPatch, extractFormState } from './formState';

// A step moved down into a list inside its item: it runs per attachment and
// keeps the mail each attachment came from as `loop.result`.
const STEP = {
    id: 'att', type: 'integration_action', tool: 'gmail_read_attachment',
    forEach: {
        overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100,
        parents: [{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }],
    },
    inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } },
};

describe('the form keeps a forEach\'s outer lists', () => {
    it('a save writes parents back, untouched', () => {
        const draft = extractFormState(STEP as never) as Record<string, unknown>;
        const patch = buildPatch(STEP as never, { ...draft, label: 'x' } as never) as { forEach?: unknown };
        if (patch.forEach !== undefined) expect(patch.forEach).toEqual(STEP.forEach);
        const moved = buildPatch(STEP as never, { ...draft, forEach: { ...STEP.forEach, maxIterations: 5 } } as never) as { forEach: unknown };
        expect(moved.forEach).toEqual({ ...STEP.forEach, maxIterations: 5 });
    });

    it('keeps only well-formed entries, and writes none for a plain list', () => {
        const before = { ...STEP, forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 } };
        const draft = extractFormState(before as never) as Record<string, unknown>;
        const odd = { ...STEP.forEach, parents: [null, { itemVar: 'x' }, { itemVar: 'result', overRef: 'steps.read.output.results[*].output', extra: 1 }] };
        expect((buildPatch(before as never, { ...draft, forEach: odd } as never) as { forEach: { parents: unknown } }).forEach.parents)
            .toEqual([{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }]);
        const plain = { overRef: 'steps.s2.output.rows', itemVar: 'row', maxIterations: 100 };
        expect((buildPatch(before as never, { ...draft, forEach: { ...plain, parents: [] } } as never) as { forEach: unknown }).forEach).toEqual(plain);
    });
});
