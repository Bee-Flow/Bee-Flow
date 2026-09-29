import { describe, it, expect } from 'vitest';
import { applyAddNode, buildStepFromPayload } from './applyAddNode';
import { DATA_EXTRACTION } from './flow/stepPalette';

/**
 * The drop scaffold for Extract data. `source` is ABSENT (a guessed source is a
 * step that quietly reads the wrong thing; the gap is a completeness warning),
 * `fields` holds ONE blank row so the panel opens on something to fill in —
 * the validator reads a nameless row as completeness too, so the seed survives
 * the first autosave.
 */
describe('applyAddNode — data_extraction scaffold', () => {
    it('drops with the palette label, an ex_ id, one blank field row and no source', () => {
        const step = buildStepFromPayload(DATA_EXTRACTION.payload, { x: 10, y: 20 });
        expect(step.type).toBe('data_extraction');
        expect(step.id).toMatch(/^ex_[a-z0-9]+$/);
        expect(step.label).toBe('Extract data');
        expect(step.fields).toEqual([{ name: '', type: 'string', description: '', required: false }]);
        expect('source' in step).toBe(false);
        expect('instructions' in step).toBe(false);
        expect(step.position).toEqual({ x: 10, y: 20 });
    });

    it('is wired from the source node like any other step', () => {
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {}, position: { x: 0, y: 0 } },
            steps: [], edges: [],
        };
        const next = applyAddNode(def, DATA_EXTRACTION.payload, { x: 200, y: 0 }, 'trg');
        expect(next.steps).toHaveLength(1);
        expect(next.edges).toEqual([{ from: 'trg', to: next.steps[0].id }]);
    });
});
