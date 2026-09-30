import type { FlowDefinition } from '@/features/flow-editor/model';

import { bareFormEntry, currentStart, runInputFor, startPoints } from './runMenu';

const ONE: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };
const MANY: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'schedule', label: 'Every morning', pinnedOutput: { at: 9 } },
    triggers: [
        { id: 'hook', type: 'trigger', kind: 'webhook', pinnedOutput: { body: 1 } },
        { id: 'form', type: 'trigger', kind: 'form' },
    ],
    steps: [],
    edges: [],
};

describe('the run menu', () => {
    it('offers "Start from" only with more than one trigger, primary first', () => {
        expect(startPoints(ONE)).toEqual([]);
        const starts = startPoints(MANY);
        expect(starts.map((s) => s.id)).toEqual([null, 'hook', 'form']);
        expect(starts[0]?.label).toBe('Every morning');
        expect(starts[1]?.label).toBeTruthy();
    });

    it('forgets a start whose trigger is gone', () => {
        expect(currentStart(MANY, 'hook')).toBe('hook');
        expect(currentStart(MANY, 'gone')).toBeNull();
        expect(currentStart(ONE, 'hook')).toBeNull();
    });

    it('sends the entry trigger’s sample, and names a secondary one (the web’s runBody)', () => {
        expect(runInputFor(ONE)).toEqual({});
        expect(runInputFor(MANY)).toEqual({ triggerPayload: { at: 9 } });
        expect(runInputFor(MANY, 'hook')).toEqual({ triggerPayload: { body: 1 }, triggerStepId: 'hook' });
        expect(runInputFor(MANY, 'form')).toEqual({ triggerStepId: 'form' });
        expect(runInputFor(MANY, 'gone')).toEqual({ triggerPayload: { at: 9 } });
    });

    it('opens a form trigger with no saved answers instead of running it live', () => {
        expect(bareFormEntry(MANY, 'form')).toBe('form');
        expect(bareFormEntry(MANY, 'hook')).toBeNull();
        expect(bareFormEntry({ ...ONE, trigger: { id: 'f', type: 'trigger', kind: 'form', pinnedOutput: { a: 1 } } }, null)).toBeNull();
    });
});
