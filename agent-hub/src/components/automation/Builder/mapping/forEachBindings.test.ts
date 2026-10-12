import { describe, expect, it, vi } from 'vitest';
import { applyStepBindings, stepBindings } from './forEachBindings';
import { pickLoopList } from './loopLists';

const DRAFT = {
    id: 's', type: 'ai_step', label: 'Summarise', forEach: { overRef: 'steps.a.output.rows', itemVar: 'row' },
    prompt: 'Summarise {{loop.row.subject}}',
    inputs: { body: { kind: 'ref', path: 'loop.row.body' }, note: { kind: 'literal', value: 'x' } },
};

describe('a step\'s fields as slots', () => {
    it('flattens inputs / fields / values, keeps plain text, skips the plumbing', () => {
        expect(stepBindings(DRAFT)).toEqual({ prompt: DRAFT.prompt, body: DRAFT.inputs.body, note: DRAFT.inputs.note });
    });

    it('re-pointing the list moves every slot, prompt included, and writes back per key', () => {
        const r = pickLoopList({ overRef: 'steps.a.output.rows', itemVar: 'row' }, { path: 'steps.b.output.mails', sample: [{ subject: 's', body: 'b' }] }, { bindings: stepBindings(DRAFT) });
        expect(r.patch).toEqual({ overRef: 'steps.b.output.mails', itemVar: 'mail', parents: undefined });
        const set = vi.fn();
        applyStepBindings(DRAFT, r.bindings as Record<string, unknown>, set);
        expect(set.mock.calls).toEqual([
            ['prompt', 'Summarise {{loop.mail.subject}}'],
            ['inputs', { body: { kind: 'ref', path: 'loop.mail.body' }, note: DRAFT.inputs.note }],
        ]);
    });

    it('a name used twice keeps both slots apart', () => {
        const d = { fields: { prompt: 'a' }, prompt: 'b' };
        expect(stepBindings(d)).toEqual({ prompt: 'a', 'step.prompt': 'b' });
        const set = vi.fn();
        applyStepBindings(d, { prompt: 'a', 'step.prompt': 'c' }, set);
        expect(set.mock.calls).toEqual([['prompt', 'c']]);
    });
});
