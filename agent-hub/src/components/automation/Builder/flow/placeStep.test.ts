import { describe, it, expect } from 'vitest';
import { applyAddNode } from '../applyAddNode';
import { spliceStepIntoEdge } from './branchEdges';
import { placeNewStep, rectsOverlap, type Rect } from './placeStep';

/**
 * The two insert paths of BuildTab.addStepAt, replayed on the pure pieces:
 * applyAddNode (+ spliceStepIntoEdge for an edge insert) and then placeNewStep.
 * The invariant is the one the canvas showed broken: no two cards overlap.
 */
type Step = { id: string; type: string; position: { x: number; y: number }; [k: string]: unknown };
type Def = { trigger: Step; steps: Step[]; edges: Array<{ from: string; to: string }> };

const W = 240;
const H = 96;
const rect = (s: Step): Rect => ({ x: s.position.x, y: s.position.y, width: W, height: H });
function overlaps(def: Def): string[] {
    const all = [def.trigger, ...def.steps];
    const hits: string[] = [];
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            if (rectsOverlap(rect(all[i]), rect(all[j]))) hits.push(`${all[i].id}~${all[j].id}`);
        }
    }
    return hits;
}

const base = (): Def => ({
    trigger: { id: 't', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } } as Step,
    steps: [],
    edges: [],
});

/** What the combobox / ribbon does: append after `sourceId`, positioned like BuildTab does. */
function append(def: Def, kind: string, sourceId: string, opts: { position?: { x: number; y: number } } = {}): Def {
    const src = [def.trigger, ...def.steps].find(n => n.id === sourceId)!;
    const position = opts.position || { x: src.position.x + 280, y: src.position.y };
    let next = applyAddNode(def, { kind }, position, sourceId as never) as Def;
    const inserted = next.steps[next.steps.length - 1];
    next = placeNewStep(next, inserted.id, { sourceId, keepIfFree: !!opts.position }) as Def;
    return next;
}

/** What "+ Insert a step here" does: the clicked edge's midpoint is the position. */
function insertOnEdge(def: Def, kind: string, sourceId: string, targetId: string): Def {
    const all = [def.trigger, ...def.steps];
    const a = all.find(n => n.id === sourceId)!.position;
    const b = all.find(n => n.id === targetId)!.position;
    let next = applyAddNode(def, { kind }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, sourceId as never) as Def;
    const insertedId = next.steps[next.steps.length - 1].id;
    const withoutAuto = next.edges.filter(e => !(e.from === sourceId && e.to === insertedId));
    next = { ...next, edges: spliceStepIntoEdge(withoutAuto, insertedId, sourceId, targetId, {}, null) as Def['edges'] };
    return placeNewStep(next, insertedId, { sourceId, targetId }) as Def;
}

describe('placeNewStep', () => {
    it('appends a card a full column right of the trigger without overlap', () => {
        const def = append(base(), 'code', 't');
        expect(overlaps(def)).toEqual([]);
        expect(def.steps[0].position.x).toBe(320);
        expect(def.steps[0].position.y).toBe(0);
    });

    it('inserting between two cards in a row overlaps nothing and keeps the order left to right', () => {
        let def = append(base(), 'code', 't');
        def = append(def, 'set', def.steps[0].id);
        const [code, set] = def.steps;
        def = insertOnEdge(def, 'notification', code.id, set.id);
        expect(overlaps(def)).toEqual([]);
        const [c, s, n] = [def.steps[0], def.steps[1], def.steps[2]];
        // trigger < code < notification < set
        expect(c.position.x).toBeLessThan(n.position.x);
        expect(n.position.x).toBeLessThan(s.position.x);
        // The downstream card slid by exactly the missing distance, no more.
        expect(s.position.x - n.position.x).toBe(320);
    });

    it('repeated inserts and appends never overlap', () => {
        let def = append(base(), 'code', 't');
        def = append(def, 'set', def.steps[0].id);
        for (let i = 0; i < 4; i++) def = insertOnEdge(def, 'notification', def.trigger.id, def.steps[0].id);
        def = append(def, 'http_request', def.steps[1].id);
        expect(overlaps(def)).toEqual([]);
    });

    it('leaves a roomy hand-arranged gap alone', () => {
        let def = append(base(), 'code', 't');
        def = append(def, 'set', def.steps[0].id);
        const far = { ...def.steps[1], position: { x: 1200, y: 0 } };
        def = { ...def, steps: [def.steps[0], far] };
        def = insertOnEdge(def, 'notification', def.steps[0].id, far.id);
        expect(def.steps.find(s => s.id === far.id)!.position.x).toBe(1200);
        expect(overlaps(def)).toEqual([]);
    });

    it('a second branch from the same source stacks below instead of on top', () => {
        let def = append(base(), 'code', 't');
        def = append(def, 'set', 't');
        expect(overlaps(def)).toEqual([]);
        expect(def.steps[1].position.x).toBe(320);
        expect(def.steps[1].position.y).toBeGreaterThan(0);
    });

    it('moves a drop point that lands on a card, keeps one that is clear', () => {
        const onTop = append(base(), 'code', 't', { position: { x: 20, y: 10 } });
        expect(overlaps(onTop)).toEqual([]);
        const clear = append(base(), 'code', 't', { position: { x: 700, y: 300 } });
        expect(clear.steps[0].position).toEqual({ x: 700, y: 300 });
    });

    it('does not move downstream cards that sit on another row', () => {
        let def = append(base(), 'code', 't');
        def = append(def, 'set', def.steps[0].id);
        const wrapped = { ...def.steps[1], position: { x: 0, y: 366 } };
        def = { ...def, steps: [def.steps[0], wrapped] };
        def = insertOnEdge(def, 'notification', def.steps[0].id, wrapped.id);
        expect(def.steps.find(s => s.id === wrapped.id)!.position).toEqual({ x: 0, y: 366 });
        expect(overlaps(def)).toEqual([]);
    });
});
