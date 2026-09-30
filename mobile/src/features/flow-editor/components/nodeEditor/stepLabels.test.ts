import type { VariableGroup } from '@/features/flow-editor/bindings';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { stepLabelsInScope } from './stepLabels';

const group = (id: string, label: string, basePath = `steps.${id}.output`): VariableGroup => ({ id, label, kind: 'step', basePath, sample: null, fields: [] });

describe('stepLabelsInScope', () => {
    const definition = { trigger: { id: 'trigger', type: 'manual', label: 'Start' }, steps: [{ id: 'lp', type: 'loop', label: 'Each order' }] } as unknown as FlowDefinition;

    it('names a sibling step inside a loop body, which the routine map does not know', () => {
        const labels = stepLabelsInScope(definition, [group('b1', 'Summarise')]);
        expect(labels.get('b1')).toBe('Summarise');
        expect(labels.get('lp')).toBe('Each order');
    });

    it('keeps the routine’s own name for a top-level step, and ignores the loop item', () => {
        const labels = stepLabelsInScope(definition, [group('lp', 'Other'), group('item', 'Loop item', 'loop.item')]);
        expect(labels.get('lp')).toBe('Each order');
        expect(labels.has('item')).toBe(false);
    });

    it('names a step inside a loop body and an unlabelled step without its id', () => {
        const nested = {
            trigger: { id: 'trigger', type: 'manual', label: 'Start' },
            steps: [{ id: 'lp', type: 'loop', label: 'Each order', body: [{ id: 'b1', type: 'ai_step', label: 'Summarise' }, { id: 'b2', type: 'ai_step' }] }],
        } as unknown as FlowDefinition;
        const labels = stepLabelsInScope(nested, []);
        expect(labels.get('b1')).toBe('Summarise');
        expect(labels.get('b2')).toBeTruthy();
        expect(labels.get('b2')).not.toBe('b2');
    });
});
