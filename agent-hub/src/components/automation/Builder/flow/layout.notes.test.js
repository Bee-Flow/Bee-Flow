import { describe, it, expect } from 'vitest';
import { buildLayout, DEFAULT_NOTE_SIZE } from './layout';

/**
 * BFSF-411 — a note's node shape (its own resizable box, not the fixed card
 * every other step uses) and the "a note without a position must not force
 * the whole graph through dagre" guarantee (mirrors the inline-steps pass
 * this file already does the same layering trick for).
 */

const trigger = () => ({ id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } });
const step = (id, over = {}) => ({ id, type: 'ai_step', position: { x: 300, y: 0 }, ...over });

describe('buildLayout — note sizing', () => {
    it('sizes a note node from its own `size`, not the shared card estimate', () => {
        const def = {
            trigger: trigger(),
            steps: [{ id: 'note_1', type: 'note', text: 'x', position: { x: 0, y: 200 }, size: { width: 300, height: 180 } }],
            edges: [],
        };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        const note = nodes.find(n => n.id === 'note_1');
        expect(note.width).toBe(300);
        expect(note.height).toBe(180);
        expect(note.style).toEqual({ width: 300, height: 180 });
    });

    it('falls back to DEFAULT_NOTE_SIZE when the note has no size yet', () => {
        const def = {
            trigger: trigger(),
            steps: [{ id: 'note_1', type: 'note', text: 'x', position: { x: 0, y: 200 } }],
            edges: [],
        };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        const note = nodes.find(n => n.id === 'note_1');
        expect(note.width).toBe(DEFAULT_NOTE_SIZE.width);
        expect(note.height).toBe(DEFAULT_NOTE_SIZE.height);
    });

    it('a real step is not given a note-shaped box', () => {
        const def = { trigger: trigger(), steps: [step('a')], edges: [{ from: 'trg', to: 'a' }] };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        expect(nodes.find(n => n.id === 'a').width).toBeUndefined();
    });
});

describe('buildLayout — a positionless note never forces a real-step re-layout', () => {
    it('every real step keeps its OWN stored position even when a note has none', () => {
        const def = {
            trigger: trigger(),
            steps: [
                step('a', { position: { x: 555, y: 111 } }),
                { id: 'note_1', type: 'note', text: 'x' }, // no position at all
            ],
            edges: [{ from: 'trg', to: 'a' }],
        };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        // Without the note exclusion, "not every node has a position" would
        // send the WHOLE graph through dagre, relocating `a` off its
        // hand-placed spot.
        expect(nodes.find(n => n.id === 'a').position).toEqual({ x: 555, y: 111 });
    });

    it('the note itself still renders at a finite position (defaults to {0,0})', () => {
        const def = {
            trigger: trigger(),
            steps: [step('a', { position: { x: 555, y: 111 } }), { id: 'note_1', type: 'note', text: 'x' }],
            edges: [{ from: 'trg', to: 'a' }],
        };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        const note = nodes.find(n => n.id === 'note_1');
        expect(Number.isFinite(note.position.x)).toBe(true);
        expect(Number.isFinite(note.position.y)).toBe(true);
    });

    it('a note WITH a stored position keeps it even when another real step lacks one', () => {
        const def = {
            trigger: trigger(),
            steps: [
                step('a'), // no position — forces the real-step dagre branch
                { id: 'note_1', type: 'note', text: 'x', position: { x: 42, y: 42 } },
            ],
            edges: [{ from: 'trg', to: 'a' }],
        };
        const { nodes } = buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
        expect(nodes.find(n => n.id === 'note_1').position).toEqual({ x: 42, y: 42 });
    });
});
