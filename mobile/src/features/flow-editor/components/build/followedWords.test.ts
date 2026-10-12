/**
 * The toast after "follow the route" re-pointed a step at what a Condition
 * keeps (W1/W2/W7): one sentence per step, naming the step and the Condition.
 * And the node editor's one-edit host of "Use what this Condition keeps".
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import type { DraftStore } from '@/features/flow-editor/state';

import { followedWords } from './useOutlineEditing';
import { followAcross } from '../nodeEditor/followAcross';

const T = (_key: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const MAILS = 'steps.mc_read_many.output.messages';
const definition = {
    trigger: { id: 'trg', type: 'trigger' },
    steps: [
        { id: 'mc_read_many', type: 'action', label: 'Read many' },
        { id: 'mc_condition', type: 'filter', label: 'Condition', arrayRef: MAILS, expr: 'contains(item.from, "fabrikam")' },
        { id: 'mc_read_attachment', type: 'action', label: 'Read attachment', forEach: { overRef: `${MAILS}[*].attachments` } },
    ],
    edges: [
        { from: 'mc_read_many', to: 'mc_condition' },
        { from: 'mc_condition', to: 'mc_read_attachment' },
    ],
} as unknown as FlowDefinition;

/** A draft store with just `applyOp`, counting the edits (each one is one Undo). */
function fakeStore(start: FlowDefinition) {
    const state = { definition: start, edits: 0 };
    const store = {
        getState: () => ({
            applyOp: (op: (d: FlowDefinition) => FlowDefinition) => {
                const next = op(state.definition);
                if (next === state.definition) return false;
                state.definition = next;
                state.edits += 1;
                return true;
            },
        }),
    } as unknown as DraftStore;
    return { store, state };
}

describe('following the route', () => {
    it('names each re-pointed step once, with the Condition it now reads from', () => {
        const rebound = [
            { stepId: 'mc_read_attachment', from: MAILS, to: 'steps.mc_condition.output.items' },
            { stepId: 'mc_read_attachment', from: `${MAILS}[*]`, to: 'steps.mc_condition.output.items[*]' },
        ];
        expect(followedWords(definition, rebound, T)).toEqual(['“Read attachment” now works through what “Condition” keeps.']);
        expect(followedWords(definition, [], T)).toEqual([]);
    });

    it('re-points the stale next step in ONE edit, and does nothing a second time', () => {
        const { store, state } = fakeStore(definition);
        const rebound = followAcross(store, 'mc_condition', ['mc_read_attachment']);
        expect(rebound?.map((r) => r.stepId)).toContain('mc_read_attachment');
        expect(state.edits).toBe(1);
        const step = state.definition.steps.find((s) => s.id === 'mc_read_attachment') as unknown as { forEach: { overRef: string } };
        expect(step.forEach.overRef).toBe('steps.mc_condition.output.items[*].attachments');
        expect(followAcross(store, 'mc_condition', ['mc_read_attachment'])).toBeUndefined();
        expect(state.edits).toBe(1);
    });
});
