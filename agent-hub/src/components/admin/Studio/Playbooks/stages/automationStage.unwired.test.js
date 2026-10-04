import { describe, expect, it } from 'vitest';
import { unreachableStep } from './AutomationStage';

/**
 * A step wired to nothing is VALID, silent, and never runs.
 *
 * `validate.test.js` pins that a disconnected step is `ok: true` with no error
 * and no warning, and `runDag` only walks from the trigger. So the automation
 * finalises "ready", the dry run reports the steps it did reach, and the fill
 * phase adds zero rows in front of the room.
 */
describe('unreachableStep — a step the trigger can never reach', () => {
    const wired = {
        trigger: { id: 'trg' },
        steps: [{ id: 's1', type: 'nextcloud_list_files' }, { id: 's2', type: 'datatable', label: 'Add row' }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };

    it('says nothing about a flow that is wired through', () => {
        expect(unreachableStep(wired)).toBeNull();
    });

    it('names the step that lost its anchor', () => {
        const orphan = { ...wired, edges: [{ from: 'trg', to: 's1' }] };
        // The label, because that is what the person sees on the canvas.
        expect(unreachableStep(orphan)).toBe('Add row');
    });

    it('falls back to the type when a step has no label', () => {
        const orphan = {
            trigger: { id: 'trg' },
            steps: [{ id: 's1', type: 'datatable' }],
            edges: [{ from: 'trg', to: 'nope' }],
        };
        expect(unreachableStep(orphan)).toBe('datatable');
    });

    it('ignores a note — a canvas annotation is not a step the automation runs', () => {
        const withNote = { ...wired, steps: [...wired.steps, { id: 'n1', type: 'note' }] };
        expect(unreachableStep(withNote)).toBeNull();
    });

    it('accepts the other edge spellings', () => {
        const alt = {
            trigger: { id: 'trg' },
            steps: [{ id: 's1', type: 'datatable' }],
            edges: [{ source: 'trg', target: 's1' }],
        };
        expect(unreachableStep(alt)).toBeNull();
    });

    it('never fails a build whose shape it does not recognise', () => {
        // No edges at all is a definition we cannot reason about — a guard that
        // guesses here would fail an automation that is perfectly fine.
        expect(unreachableStep({ trigger: { id: 'trg' }, steps: [{ id: 's1', type: 'datatable' }], edges: [] })).toBeNull();
        expect(unreachableStep({ steps: [{ id: 's1' }] })).toBeNull();
        expect(unreachableStep(null)).toBeNull();
        expect(unreachableStep({})).toBeNull();
    });
});
