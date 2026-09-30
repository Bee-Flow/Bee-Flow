import type { FlowDefinition } from '@/features/flow-editor/model';
import { branchy, clone, FIXTURES, loopy, switchy } from '@/features/flow-editor/model/testing/fixtures';

import { moveNode } from './moves';
import { buildScene, ENTRY_H, NOTE_SIZE } from './scene';
import { ADD_GAP } from './sceneEdges';
import { bigFlow, placedBigFlow } from './testing';

const keysOf = (xs: readonly { key: string }[]) => xs.map((x) => x.key);

describe('the scene of a routine', () => {
    it('draws every node with its ports, and a condition with its two named ones', () => {
        const scene = buildScene(clone(branchy));
        expect(keysOf(scene.nodes)).toEqual(['trg', 'cond_1', 'act_a', 'act_b', 'notif_1']);
        const trigger = scene.byKey.get('trg');
        expect(trigger?.kind).toBe('trigger');
        expect(trigger?.targetDy).toBeNull();
        const cond = scene.byKey.get('cond_1');
        expect(cond?.ports.map((p) => [p.id, p.wire, p.dy])).toEqual([['then', 'then', 24], ['else', 'else', 48]]);
        expect(cond?.ports.map((p) => (p.text && 'key' in p.text ? p.text.fallback : null))).toEqual(['match', 'otherwise']);
        expect(scene.seeded).toBe(true);
    });

    it('classifies and places its lines, and knows what their "+" does', () => {
        const scene = buildScene(clone(branchy));
        const then = scene.edges.find((e) => e.from === 'cond_1' && e.kind === 'then');
        const cond = scene.byKey.get('cond_1');
        expect(then?.sourcePort).toBe('then');
        expect(then?.labelledAtPort).toBe(true);
        expect(then?.geometry.d.startsWith(`M${(cond?.x ?? 0) + 240} ${(cond?.y ?? 0) + 24}`)).toBe(true);
        expect(then?.insert).toEqual({ kind: 'splice', sourceId: 'cond_1', targetId: then?.to, identity: { label: 'then' } });
        expect(then?.removable).toBe(true);
        // Only the last step has nowhere to go.
        expect(scene.adds.map((a) => a.target)).toEqual([{ kind: 'after', sourceId: 'notif_1', handle: null }]);
        const last = scene.byKey.get('notif_1');
        expect(scene.adds[0]).toMatchObject({ x: (last?.x ?? 0) + 240 + ADD_GAP, y: (last?.y ?? 0) + 36 });
    });

    it('grows a switch card for its ports and names every case', () => {
        const scene = buildScene(clone(switchy));
        const sw = scene.byKey.get('sw');
        expect(sw?.ports.map((p) => p.id)).toEqual(['case:gold', 'case:silver', 'case:bronze', 'case:default']);
        expect(sw?.height).toBe(4 * 22 + 20);
        expect(scene.seeded).toBe(false);
        // Every placed node is drawn exactly where it was put.
        for (const s of switchy.steps) expect(scene.byKey.get(s.id)).toMatchObject({ x: s.position?.x, y: s.position?.y });
        // A stop-with-error has no way out, so no "+".
        expect(scene.byKey.get('dflt')?.ports).toEqual([]);
        expect(scene.adds.some((a) => a.owner === 'dflt')).toBe(false);
        // The coloured edge keeps its colour.
        expect(scene.edges.find((e) => e.to === 'br')?.defColor).toBe('amber');
    });

    it('draws a closed loop as a card with its two ports', () => {
        const scene = buildScene(clone(loopy));
        const loop = scene.byKey.get('loop_1');
        expect(loop?.kind).toBe('step');
        expect(loop?.bodyCount).toBe(3);
        expect(loop?.ports.map((p) => [p.id, p.wire])).toEqual([['done', null], ['on_error', 'on_error']]);
        expect(scene.edges.find((e) => e.from === 'loop_1')?.sourcePort).toBe('done');
        expect(scene.nodes.some((n) => n.parent)).toBe(false);
    });

    it('opens a loop: its body inside, chained, each "+" inserting into the body', () => {
        const scene = buildScene(clone(loopy), new Set(['loop_1']));
        const box = scene.byKey.get('loop_1');
        expect(box?.kind).toBe('container');
        expect(box?.targetDy).toBe(23);
        const inside = scene.nodes.filter((n) => n.parent === 'loop_1');
        expect(keysOf(inside)).toEqual(['loop_1/__item__', 'loop_1/b_cond', 'loop_1/b_sw', 'loop_1/b_set']);
        expect(inside[0]?.kind).toBe('entry');
        expect(inside[0]?.height).toBe(ENTRY_H);
        for (const n of inside) {
            expect(n.x).toBeGreaterThanOrEqual(box?.x ?? 0);
            expect(n.y + n.height).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
            expect(n.draggable).toBe(false);
        }
        const body = scene.edges.filter((e) => e.container === 'loop_1');
        expect(body.map((e) => [e.from, e.to, e.kind])).toEqual([
            ['loop_1/__item__', 'loop_1/b_cond', null],
            ['loop_1/b_cond', 'loop_1/b_sw', 'then'],
            ['loop_1/b_sw', 'loop_1/b_set', 'eu'],
            ['loop_1/b_sw', 'loop_1/b_set', 'default'],
        ]);
        expect(body.map((e) => e.insert)).toEqual([0, 1, 2, 2].map((index) => ({ kind: 'inline', container: 'loop_1', branch: null, index })));
        expect(body.every((e) => !e.removable)).toBe(true);
        expect(scene.adds.find((a) => a.owner === 'loop_1/b_set')?.target).toEqual({ kind: 'inline', container: 'loop_1', branch: null, index: 3 });
        // The step after the loop moved out of the container's way.
        expect(scene.byKey.get('lim')?.x).toBeGreaterThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));
    });

    it('gives an empty open loop a "+" on its entry', () => {
        const def: FlowDefinition = { trigger: { id: 't', type: 'trigger' }, steps: [{ id: 'l', type: 'loop', body: [] }], edges: [{ from: 't', to: 'l' }] };
        const scene = buildScene(def, new Set(['l']));
        expect(scene.adds.find((a) => a.owner === 'l/__item__')?.target).toEqual({ kind: 'inline', container: 'l', branch: null, index: 0 });
    });

    it('draws notes as boxes with no ports, and skips what it cannot draw', () => {
        const multi = buildScene(clone(FIXTURES.multi as FlowDefinition));
        const note = multi.nodes.find((n) => n.kind === 'note');
        expect(note).toMatchObject({ ports: [], targetDy: null, width: NOTE_SIZE.width, height: NOTE_SIZE.height });
        const tangled = buildScene(clone(FIXTURES.tangled as FlowDefinition));
        expect(new Set(keysOf(tangled.nodes)).size).toBe(tangled.nodes.length);
        for (const e of tangled.edges) expect(tangled.byKey.has(e.from) && tangled.byKey.has(e.to)).toBe(true);
    });

    it('draws nothing for an empty routine', () => {
        const scene = buildScene({ trigger: null, steps: [], edges: [] });
        expect(scene.nodes).toEqual([]);
        expect(scene.bounds).toBeNull();
    });
});

describe('a 150-step routine', () => {
    it('is laid out and drawn in time, every line between two drawn nodes', () => {
        const def = bigFlow();
        const t0 = Date.now();
        const scene = buildScene(def);
        const first = Date.now() - t0;
        expect(scene.nodes.length).toBe(1 + def.steps.length);
        expect(scene.edges.length).toBe(def.edges.length);
        const t1 = Date.now();
        for (let i = 0; i < 10; i += 1) buildScene(def);
        const again = (Date.now() - t1) / 10;
        // Generous bounds for a loaded CI box; the layout is cached after the first pass.
        expect(first).toBeLessThan(3000);
        expect(again).toBeLessThan(150);
    });

    it('changes only the moved node (and its lines) when one node moves', () => {
        const def = placedBigFlow();
        const before = buildScene(def);
        const after = buildScene(moveNode(def, 's40', { dx: 30, dy: 12 }));
        const changed = after.nodes.filter((n) => n.geom !== before.byKey.get(n.key)?.geom).map((n) => n.key);
        expect(changed).toEqual(['s40']);
        const moved = after.edges.filter((e, i) => e.geometry.d !== before.edges[i]?.geometry.d);
        expect(moved.every((e) => e.from === 's40' || e.to === 's40')).toBe(true);
        expect(moved.length).toBeGreaterThan(0);
    });
});
