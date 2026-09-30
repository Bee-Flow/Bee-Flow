import { insertStep } from '@/features/flow-editor/model/outline';
import { chain, clone } from '@/features/flow-editor/model/testing/fixtures';

import { endHere, spliceEveryTrigger } from './useOutlineEditing';

describe('a step that ends the run, put between two steps', () => {
    it('loses its line to the next step, and says how many went', () => {
        const def = clone(chain);
        const next = def.edges.find((e) => e.from === 'c3')?.to as string;
        const inserted = insertStep(def, { kind: 'splice', sourceId: 'c3', targetId: next, identity: {} }, { kind: 'stop_error' });
        const { result, cut } = endHere(inserted, { kind: 'stop_error' });
        expect(cut).toBe(1);
        expect(result.definition.edges.some((e) => e.from === result.addedId)).toBe(false);
        expect(result.definition.edges).toContainEqual(expect.objectContaining({ from: 'c3', to: result.addedId }));
    });

    it('leaves any other step as inserted', () => {
        const inserted = insertStep(clone(chain), { kind: 'after', sourceId: 'c3', handle: null }, { kind: 'wait' });
        expect(endHere(inserted, { kind: 'wait' }).cut).toBe(0);
    });
});

describe('the "+" under a stack of triggers', () => {
    it('puts the new step after every trigger that entered that step', () => {
        const def = clone(chain);
        const first = def.edges.find((e) => e.from === def.trigger?.id)?.to as string;
        def.triggers = [{ id: 'trg2', type: 'trigger', kind: 'webhook' }];
        def.edges = [...def.edges, { from: 'trg2', to: first }];
        const target = { kind: 'splice' as const, sourceId: def.trigger?.id as string, targetId: first, identity: {} };
        const done = spliceEveryTrigger(insertStep(def, target, { kind: 'wait' }), target, def);
        expect(done.definition.edges).toContainEqual(expect.objectContaining({ from: 'trg2', to: done.addedId }));
        expect(done.definition.edges).not.toContainEqual(expect.objectContaining({ from: 'trg2', to: first }));
    });
});
