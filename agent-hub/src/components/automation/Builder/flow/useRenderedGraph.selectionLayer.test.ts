import { describe, it, expect } from 'vitest';
import { NOTE_Z_INDEX } from './layout';
import { applySelectionLayering } from './useRenderedGraph';
import { partial } from '@/test/mocks';

/**
 * BFSF-479 — the canvas runs with elevateNodesOnSelect={false} so a note
 * stays in its background layer even while selected; this helper re-applies
 * React Flow's +1000 selection pop to every selected NON-note node, which is
 * what keeps real cards popping to front exactly as before.
 */

const node = (id: string, over = {}) => ({ id, type: 'ai_step', ...over });

describe('applySelectionLayering', () => {
    it('lifts a selected real node to the front layer', () => {
        const out = applySelectionLayering(partial<Parameters<typeof applySelectionLayering>[0]>([node('a', { selected: true })]));
        expect(out[0].zIndex).toBe(1000);
    });

    it('leaves an unselected real node on the default layer', () => {
        const out = applySelectionLayering(partial<Parameters<typeof applySelectionLayering>[0]>([node('a')]));
        expect(out[0].zIndex).toBeUndefined();
    });

    it('never lifts a note — selected or not, its background z-index stands', () => {
        const out = applySelectionLayering(partial<Parameters<typeof applySelectionLayering>[0]>([
            { id: 'note_1', type: 'note', selected: true, zIndex: NOTE_Z_INDEX },
        ]));
        expect(out[0].zIndex).toBe(NOTE_Z_INDEX);
    });

    it('respects an explicit z-index a node already carries', () => {
        const out = applySelectionLayering(partial<Parameters<typeof applySelectionLayering>[0]>([node('a', { selected: true, zIndex: -1 })]));
        expect(out[0].zIndex).toBe(-1);
    });

    it('does not mutate the input nodes', () => {
        const input = [node('a', { selected: true }), { id: 'note_1', type: 'note', selected: true, zIndex: NOTE_Z_INDEX }];
        const out = applySelectionLayering(partial<Parameters<typeof applySelectionLayering>[0]>(input));
        expect((input[0] as { zIndex?: number }).zIndex).toBeUndefined();
        expect(out[1]).toBe(input[1]);
    });
});
