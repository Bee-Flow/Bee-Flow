import type { FlowDefinition, FlowStep } from '@/features/flow-editor/model';
import { branchy, chain, clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { stepActions } from './actions';
import { canMove, detachStep, duplicateStep, moveStep, removeStep, toggleDisabled, togglePin } from './edits';
import { findAtAddress, inlineList, updateAtAddress } from './nested';

const pairs = (def: FlowDefinition) => def.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`);

describe('moving a card', () => {
    it('swaps two neighbours in a straight run by rewriting the edges around them', () => {
        const def = clone(chain);
        expect(canMove(def, 'c1', 'up')).toBe(true);
        const next = moveStep(def, 'c1', 'up');
        expect(pairs(next).slice(0, 3)).toEqual(['trg>c1', 'c1>c0', 'c0>c2']);
        expect(moveStep(next, 'c1', 'down')).toEqual(def);
    });

    it('keeps an edge colour on the link it swaps', () => {
        const def = clone(chain);
        def.edges[2] = { ...def.edges[2], color: 'rose' } as FlowDefinition['edges'][number];
        const next = moveStep(def, 'c2', 'up');
        expect(next.edges.find((e) => e.from === 'c2' && e.to === 'c1')?.color).toBe('rose');
    });

    it('never moves above the trigger, through a branch or into a join', () => {
        const def = clone(branchy);
        expect(canMove(chain, 'c0', 'up')).toBe(false);
        expect(canMove(def, 'act_a', 'up')).toBe(false);
        expect(canMove(def, 'act_a', 'down')).toBe(false);
        expect(canMove(def, 'cond_1', 'down')).toBe(false);
        expect(moveStep(def, 'act_a', 'down')).toBe(def);
    });

    it('never moves a step above the step whose output it reads', () => {
        const def = clone(chain);
        def.steps = def.steps.map((s) => (s.id === 'c2' ? { ...s, inputs: { total: { kind: 'ref', path: 'steps.c1.output.total' } } } : s));
        expect(canMove(def, 'c2', 'up')).toBe(false);
        expect(canMove(def, 'c1', 'down')).toBe(false);
        expect(moveStep(def, 'c2', 'up')).toBe(def);
        expect(canMove(def, 'c3', 'up')).toBe(true);

        const held = clone(loopy);
        const withRef = updateAtAddress(held, 'loop_1/b_sw', (s) => ({ ...s, note: '{{steps.b_cond.output.ok}}' }));
        expect(canMove(withRef, 'loop_1/b_sw', 'up')).toBe(false);
        expect(canMove(withRef, 'loop_1/b_cond', 'down')).toBe(false);
        expect(canMove(withRef, 'loop_1/b_sw', 'down')).toBe(true);
    });

    it('reorders a loop body as a list', () => {
        const def = clone(loopy);
        expect(canMove(def, 'loop_1/b_cond', 'up')).toBe(false);
        const next = moveStep(def, 'loop_1/b_cond', 'down');
        const body = inlineList(findAtAddress(next, 'loop_1'), null).map((s) => s.id);
        expect(body).toEqual(['b_sw', 'b_cond', 'b_set']);
        expect(canMove(next, 'loop_1/b_set', 'down')).toBe(false);
    });
});

describe('removing, duplicating, detaching', () => {
    it('heals the chain around a removed step', () => {
        const next = removeStep(clone(chain), 'c1');
        expect(pairs(next)).toContain('c0>c2');
        expect(next.steps.some((s) => s.id === 'c1')).toBe(false);
    });

    it('never removes the primary trigger', () => {
        const def = clone(chain);
        expect(removeStep(def, 'trg')).toBe(def);
    });

    it('removes and duplicates held steps in their list', () => {
        const def = clone(loopy);
        const without = removeStep(def, 'loop_1/b_sw');
        expect(inlineList(findAtAddress(without, 'loop_1'), null).map((s) => s.id)).toEqual(['b_cond', 'b_set']);
        const { definition, address } = duplicateStep(def, 'loop_1/b_set');
        const body = inlineList(findAtAddress(definition, 'loop_1'), null);
        expect(body).toHaveLength(4);
        expect(address).toBe(`loop_1/${body[3]?.id}`);
        expect(body[3]?.label).toBe('B_SET (copy)');
    });

    it('duplicates a wired step as a sibling off the same predecessor', () => {
        const { definition, address } = duplicateStep(clone(chain), 'c3');
        expect(address).toBeTruthy();
        expect(pairs(definition)).toContain(`c2>${address}`);
    });

    it('detaches a wired step but leaves a held one alone', () => {
        const next = detachStep(clone(chain), 'c1');
        expect(next.edges.some((e) => e.from === 'c1' || e.to === 'c1')).toBe(false);
        const def = clone(loopy);
        expect(detachStep(def, 'loop_1/b_set')).toBe(def);
    });
});

describe('pinning', () => {
    const at = new Date('2026-09-24T10:00:00.000Z');

    it('freezes a run output and releases it again, as the web card does', () => {
        const pinned = togglePin(clone(chain), 'c1', { rows: 3 }, at);
        const step = pinned.steps.find((s) => s.id === 'c1') as FlowStep;
        expect(step.pinnedOutput).toEqual({ rows: 3 });
        expect(step.pinnedAt).toBe(at.toISOString());
        expect('pinnedSource' in step && step.pinnedSource !== undefined).toBe(false);
        const released = togglePin(pinned, 'c1', undefined, at).steps.find((s) => s.id === 'c1') as FlowStep;
        expect(released.pinnedOutput).toBeNull();
        expect(released.pinnedAt).toBeNull();
    });

    it('has nothing to pin without an output', () => {
        const def = clone(chain);
        expect(togglePin(def, 'c1', undefined, at)).toBe(def);
    });
});

describe('a card’s menu', () => {
    const ids = (list: ReturnType<typeof stepActions>) => list.map((a) => `${a.id}${a.enabled ? '' : ' (off)'}`);

    it('offers a trigger only opening; the primary cannot be removed', () => {
        expect(ids(stepActions(chain, 'trg'))).toEqual(['open']);
    });

    it('offers another trigger from the primary’s card, where the screen can add one', () => {
        expect(ids(stepActions(chain, 'trg', { addTrigger: true }))).toEqual(['open', 'addTrigger']);
        expect(ids(stepActions(chain, 'c1', { addTrigger: true }))).not.toContain('addTrigger');
    });

    it('keeps the run entries waiting while a test is out', () => {
        expect(ids(stepActions(chain, 'c1', { running: true })).slice(0, 4)).toEqual(['open', 'test (off)', 'runUpTo (off)', 'runFrom (off)']);
    });

    it('offers a wired step the whole set, pin only with a run output', () => {
        expect(ids(stepActions(chain, 'c1'))).toEqual(['open', 'test', 'runUpTo', 'runFrom', 'duplicate', 'moveUp', 'moveDown', 'disable', 'detach', 'delete']);
        const withRun = ids(stepActions(chain, 'c1', { run: { status: 'success', output: [] } }));
        expect(withRun).toContain('pin');
    });

    it('offers a held step list edits only, and nothing to edit while the AI builds', () => {
        expect(ids(stepActions(loopy, 'loop_1/b_sw'))).toEqual(['open', 'duplicate', 'moveUp', 'moveDown', 'disable', 'delete']);
        expect(ids(stepActions(chain, 'c1', { locked: true }))).toEqual([
            'open', 'test', 'runUpTo', 'runFrom', 'duplicate (off)', 'moveUp (off)', 'moveDown (off)', 'disable (off)', 'detach (off)', 'delete (off)',
        ]);
    });

    it('opens a called flowlet from its call, and leaves the runs out where there are none', () => {
        const def: FlowDefinition = {
            ...clone(chain),
            steps: [...clone(chain).steps, { id: 'call', type: 'call_layer', layerKey: 'lk' }, { id: 'dead', type: 'call_layer', layerKey: 'gone' }],
            layers: { lk: { steps: [], edges: [] } },
        };
        expect(ids(stepActions(def, 'call'))).toContain('openFlowlet');
        expect(ids(stepActions(def, 'dead'))).not.toContain('openFlowlet');
        expect(ids(stepActions(def, 'c1', { canRun: false }))).not.toContain('test');
    });

    it('switches a step off and back on, wired or held, as the web node editor does', () => {
        const off = toggleDisabled(chain, 'c1');
        expect(off.steps.find((s) => s.id === 'c1')?.disabled).toBe(true);
        expect(ids(stepActions(off, 'c1'))).toContain('enable');
        expect(toggleDisabled(off, 'c1').steps.find((s) => s.id === 'c1')?.disabled).toBe(false);
        const heldOff = toggleDisabled(loopy, 'loop_1/b_sw');
        expect(findAtAddress(heldOff, 'loop_1/b_sw')?.disabled).toBe(true);
        expect(toggleDisabled(chain, 'nope')).toBe(chain);
    });
});
