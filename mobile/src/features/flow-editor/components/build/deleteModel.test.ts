import type { FlowDefinition } from '@/features/flow-editor/model';
import { branchy, clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { deleteKindOf, deleteStep } from './deleteModel';

describe('deleting a step on the phone', () => {
    it('names a branching step and a container, and lets any other step be', () => {
        expect(deleteKindOf(branchy, 'cond_1')).toBe('branching');
        const loop = loopy.steps.find((s) => s.type === 'loop')?.id as string;
        expect(deleteKindOf(loopy, loop)).toBe('container');
        const plain = branchy.steps.find((s) => s.id !== 'cond_1' && branchy.edges.filter((e) => e.from === s.id).length <= 1)?.id as string;
        expect(deleteKindOf(branchy, plain)).toBe('plain');
    });

    it('takes a condition out with its branch lines, instead of making both branches run', () => {
        const def: FlowDefinition = clone(branchy);
        const into = def.edges.filter((e) => e.to === 'cond_1').map((e) => e.from);
        const after = deleteStep(def, 'cond_1');
        expect(after.steps.some((s) => s.id === 'cond_1')).toBe(false);
        expect(after.edges.some((e) => e.from === 'cond_1' || e.to === 'cond_1')).toBe(false);
        // Nothing before it was wired straight to its branch targets.
        const targets = def.edges.filter((e) => e.from === 'cond_1').map((e) => e.to);
        for (const from of into) for (const to of targets) expect(after.edges).not.toContainEqual(expect.objectContaining({ from, to }));
    });
});
