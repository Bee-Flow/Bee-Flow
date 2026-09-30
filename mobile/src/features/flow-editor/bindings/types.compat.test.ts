/**
 * The editor's state holds model/types.ts's strict definition and hands it to
 * the bindings layer, the form state and the schema form, which read it
 * through bindings/types.ts's read view. That only works while every strict
 * shape is assignable to its read view — checked by `tsc --noEmit` on the
 * assignments below; the runtime expectations just make them execute.
 */

import { buildSchemaFormModel, updateInput } from '@/features/flow-editor/schemaForm';

import { buildPatch, extractFormState } from '../formState';
import { applyAutoMapToStep, computeUpstreamGroups } from './index';
import type * as Read from './types';
import type * as Model from '../model/types';

const asRead = {
    definition: (d: Model.FlowDefinition): Read.FlowDefinition => d,
    step: (s: Model.FlowStep): Read.FlowNode => s,
    trigger: (s: Model.FlowTrigger): Read.FlowNode => s,
    edge: (e: Model.FlowEdge): Read.FlowEdge => e,
    forEach: (f: Model.ForEach): Read.ForEach => f,
    binding: (b: Model.Binding): Read.Binding => b,
    translate: (t: Model.Translate): Read.Translate => t,
};

const step: Model.FlowStep = { id: 's1', type: 'ai_step', inputs: { prompt: { kind: 'ref', path: 'trigger.output.text' } } };
const definition: Model.FlowDefinition = {
    trigger: { id: 'trigger', type: 'trigger', kind: 'manual' },
    steps: [step],
    edges: [{ from: 'trigger', to: 's1' }],
};

describe('model types flow into the bindings read view', () => {
    it('reads a strict definition without a cast', () => {
        expect(asRead.definition(definition)).toBe(definition);
        expect(Object.keys(asRead)).toHaveLength(7);
        expect(computeUpstreamGroups(definition, 's1', null, null).map((g) => g.id)).toContain('trigger');
    });

    it('hands a strict definition back as the same type', () => {
        const out: { definition: Model.FlowDefinition } = applyAutoMapToStep(definition, 's1', null);
        expect(out.definition).toBe(definition);
    });

    it('edits a strict step through the form state and the schema form', () => {
        const draft = extractFormState(step);
        expect(buildPatch(step, draft)).toHaveProperty('label', null);
        const inputs: Model.FlowStep['inputs'] = updateInput(step.inputs, 'extra', { kind: 'literal', value: 'x' });
        expect(Object.keys(inputs ?? {})).toStrictEqual(['prompt', 'extra']);
        expect(buildSchemaFormModel({ inputs: step.inputs }).mode).toBeDefined();
    });
});
