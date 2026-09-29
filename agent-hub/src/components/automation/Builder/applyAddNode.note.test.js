import { describe, it, expect } from 'vitest';
import { applyAddNode, buildStepFromPayload } from './DiagramPane';

/**
 * BFSF-411 — the canvas's drop/create scaffold for a note: it must never
 * gain an edge, even when the drop gesture that normally WOULD wire a step
 * (a sourceId from an edge-splice or a "chain onto this node" drop) is
 * present. BuildTab.jsx's `wirable` flag already keeps sourceId null for a
 * note on every real UI path — this is the deeper, defence-in-depth guard
 * inside applyAddNode itself.
 */

function baseDef() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
        steps: [{ id: 'a', type: 'ai_step', position: { x: 300, y: 0 } }],
        edges: [{ from: 'trg', to: 'a' }],
    };
}

describe('buildStepFromPayload — note', () => {
    it('seeds text from the payload and defaults it to empty, no size/color invented', () => {
        const step = buildStepFromPayload({ kind: 'note' }, { x: 10, y: 20 });
        expect(step.type).toBe('note');
        expect(step.text).toBe('');
        expect(step.position).toEqual({ x: 10, y: 20 });
        expect(step.size).toBeUndefined();
        expect(step.color).toBeUndefined();
    });

    it('carries through explicit text from the payload', () => {
        const step = buildStepFromPayload({ kind: 'note', text: 'why this exists' }, { x: 0, y: 0 });
        expect(step.text).toBe('why this exists');
    });
});

describe('applyAddNode — a note never gains an edge', () => {
    it('appends loose even when dropped with no sourceId (the common case)', () => {
        const next = applyAddNode(baseDef(), { kind: 'note', text: 'x' }, { x: 100, y: 100 });
        const note = next.steps.find(s => s.type === 'note');
        expect(note).toBeTruthy();
        expect(next.edges.some(e => e.from === note.id || e.to === note.id)).toBe(false);
    });

    it('still appends loose even when a sourceId/sourceHandle IS supplied — the defence-in-depth guard', () => {
        // Simulates a drag that resolved a wiring target (edge-splice or
        // chain-onto-node) despite BuildTab's `wirable` flag normally
        // preventing this from ever reaching here for a note.
        const before = baseDef();
        const next = applyAddNode(before, { kind: 'note', text: 'x' }, { x: 100, y: 100 }, 'a', 'then');
        const note = next.steps.find(s => s.type === 'note');
        expect(note).toBeTruthy();
        expect(next.edges).toEqual(before.edges); // byte-identical — nothing was added
    });

    it('other step kinds are unaffected — they still wire from sourceId as before', () => {
        const next = applyAddNode(baseDef(), { kind: 'code', label: 'Code' }, { x: 100, y: 100 }, 'a');
        const added = next.steps.find(s => s.type === 'code');
        expect(next.edges.some(e => e.from === 'a' && e.to === added.id)).toBe(true);
    });
});
