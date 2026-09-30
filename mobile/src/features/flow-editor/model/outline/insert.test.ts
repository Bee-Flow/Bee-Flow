import { seedPositions, type FlowDefinition } from '@/features/flow-editor/model';
import { branchy, chain, clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { insertStep, positionFor } from './insert';
import { findAtAddress, inlineList } from './nested';

const pairs = (def: FlowDefinition) => def.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`);

describe('insertStep', () => {
    it('keeps the drawn layout of a routine nobody placed: the new step lands by its source, nothing else moves', () => {
        const def = clone(chain);
        def.steps = def.steps.map(({ position: _p, ...s }) => s);
        if (def.trigger) delete def.trigger.position;
        const drawn = seedPositions(def) as FlowDefinition;
        const { definition, addedId } = insertStep(def, { kind: 'after', sourceId: 'c3', handle: null }, { kind: 'wait' });
        const added = definition.steps.find((s) => s.id === addedId);
        expect(added?.position).not.toEqual({ x: 0, y: 0 });
        const src = drawn.steps.find((s) => s.id === 'c3')?.position;
        expect(added?.position).toEqual({ x: (src?.x ?? 0) + 280, y: src?.y });
        for (const s of drawn.steps) expect(definition.steps.find((d) => d.id === s.id)?.position).toEqual(s.position);
    });

    it('appends after a step, wired from its port, placed to its right', () => {
        const def = clone(chain);
        def.steps = def.steps.map((s, i) => ({ ...s, position: { x: i * 280, y: 40 } }));
        const { definition, addedId } = insertStep(def, { kind: 'after', sourceId: 'c11', handle: null }, { kind: 'wait' });
        expect(addedId).toMatch(/^step_/);
        expect(pairs(definition)).toContain(`c11>${addedId}`);
        const added = definition.steps.find((s) => s.id === addedId);
        const src = def.steps.find((s) => s.id === 'c11');
        expect(added?.position).toEqual({ x: (src?.position?.x ?? 0) + 280, y: 40 });
    });

    it('wires from a named port', () => {
        const def = clone(branchy);
        const { definition, addedId } = insertStep(def, { kind: 'after', sourceId: 'cond_1', handle: 'else' }, { kind: 'set' });
        expect(pairs(definition)).toContain(`cond_1>${addedId}:else`);
    });

    it('splices onto exactly one edge, keeping its branch on the first half', () => {
        const def = clone(branchy);
        const target = { kind: 'splice' as const, sourceId: 'cond_1', targetId: 'act_a', identity: { label: 'then' } };
        const { definition, addedId } = insertStep(def, target, { kind: 'wait' });
        expect(pairs(definition)).toEqual(expect.arrayContaining([`cond_1>${addedId}:then`, `${addedId}>act_a`, 'cond_1>act_b:else']));
        expect(pairs(definition)).not.toContain('cond_1>act_a:then');
    });

    it('leaves a spliced route step by its first port', () => {
        const def = clone(chain);
        const { definition, addedId } = insertStep(def, { kind: 'splice', sourceId: 'c0', targetId: 'c1', identity: {} }, { kind: 'condition' });
        expect(pairs(definition)).toEqual(expect.arrayContaining([`c0>${addedId}`, `${addedId}>c1:then`]));
    });

    it('puts a held step into a loop body at the "+" it came from', () => {
        const def = clone(loopy);
        const { definition, addedId, address } = insertStep(def, { kind: 'inline', container: 'loop_1', branch: null, index: 1 }, { kind: 'set' });
        const body = inlineList(findAtAddress(definition, 'loop_1'), null);
        expect(body.map((s) => s.id)).toEqual(['b_cond', addedId, 'b_sw', 'b_set']);
        expect(address).toBe(`loop_1/${addedId}`);
        expect(body[1]?.position).toBeUndefined();
        expect(definition.edges).toEqual(def.edges);
    });

    it('never wires a trigger or a note, whatever the "+" said', () => {
        const def = clone(chain);
        const note = insertStep(def, { kind: 'after', sourceId: 'c0', handle: null }, { kind: 'note' });
        expect(note.definition.edges).toEqual(def.edges);
        const trigger = insertStep(def, { kind: 'after', sourceId: 'c0', handle: null }, { kind: 'trigger', triggerKind: 'webhook', asSecondaryTrigger: true });
        expect(trigger.definition.triggers?.map((t) => t.kind)).toEqual(['webhook']);
        expect(trigger.definition.edges).toEqual(def.edges);
    });

    it('adds nothing for a payload that places nothing', () => {
        const def = clone(chain);
        const out = insertStep(def, { kind: 'root' }, { kind: 'create_layer' });
        expect(out.addedId).toBeNull();
        expect(out.definition).toBe(def);
    });

    it('says whether the new step is wired from a source (auto-map follows only then)', () => {
        expect(insertStep(clone(chain), { kind: 'after', sourceId: 'c11', handle: null }, { kind: 'wait' }).wired).toBe(true);
        expect(insertStep(clone(chain), { kind: 'after', sourceId: 'c0', handle: null }, { kind: 'note' }).wired).toBe(false);
        expect(insertStep(clone(loopy), { kind: 'inline', container: 'loop_1', branch: null, index: 0 }, { kind: 'set' }).wired).toBe(false);
    });

    it('places a step between the two ends of the edge it splits', () => {
        const def = clone(branchy);
        const a = def.steps.find((s) => s.id === 'act_a')?.position;
        const n = def.steps.find((s) => s.id === 'notif_1')?.position;
        const pos = positionFor(def, { kind: 'splice', sourceId: 'act_a', targetId: 'notif_1', identity: {} });
        if (a && n) expect(pos?.x).toBe(Math.round((a.x + n.x) / 2));
    });
});
