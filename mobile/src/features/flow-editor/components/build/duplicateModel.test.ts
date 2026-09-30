import type { FlowDefinition } from '@/features/flow-editor/model';
import { allIds, findAtAddress } from '@/features/flow-editor/model/outline';
import { branchy, chain, clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { duplicateSafely } from './duplicateModel';

describe('duplicating a step on the phone', () => {
    it('puts the copy after the original, so the flow does not fork', () => {
        const def: FlowDefinition = clone(chain);
        const next = def.edges.find((e) => e.from === 'c3')?.to as string;
        const { definition, address } = duplicateSafely(def, 'c3');
        expect(address).toBeTruthy();
        expect(definition.edges).toContainEqual({ from: 'c3', to: address });
        expect(definition.edges.filter((e) => e.from === 'c3')).toHaveLength(1);
        expect(definition.edges).toContainEqual(expect.objectContaining({ from: address, to: next }));
        expect(definition.edges.filter((e) => e.to === address)).toHaveLength(1);
    });

    it('leaves a branching step’s copy unwired rather than guessing a branch', () => {
        const { definition, address } = duplicateSafely(clone(branchy), 'cond_1');
        expect(definition.edges.some((e) => e.from === address || e.to === address)).toBe(false);
        expect(definition.edges.filter((e) => e.from === 'cond_1').length).toBe(branchy.edges.filter((e) => e.from === 'cond_1').length);
    });

    it('gives every step inside a copied loop a new id', () => {
        const loop = loopy.steps.find((s) => s.type === 'loop')?.id as string;
        const { definition, address } = duplicateSafely(clone(loopy), loop);
        const ids: string[] = [];
        const walk = (steps: FlowDefinition['steps']) => {
            for (const s of steps) {
                ids.push(s.id);
                walk(((s as { body?: FlowDefinition['steps'] }).body ?? []).filter(Boolean));
            }
        };
        walk(definition.steps);
        expect(new Set(ids).size).toBe(ids.length);
        expect(findAtAddress(definition, address as string)).toBeTruthy();
        expect(allIds(definition).size).toBeGreaterThan(allIds(loopy).size);
    });
});
