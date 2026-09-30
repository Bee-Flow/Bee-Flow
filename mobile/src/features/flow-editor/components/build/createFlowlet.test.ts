/**
 * "Create flowlet" from the picker: a new flowlet and a call to it where the
 * "+" was, in one edit — the web's scope-spanning insert.
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import { chain, clone } from '@/features/flow-editor/model/testing/fixtures';

import { createFlowletOp } from './useOutlineEditing';

it('adds the flowlet and wires a call to it onto the edge', () => {
    const made: { key: string | null } = { key: null };
    const next = createFlowletOp({ kind: 'splice', sourceId: 'c0', targetId: 'c1', identity: {} }, 'Enrich', made)(clone(chain)) as FlowDefinition;
    expect(made.key).toMatch(/^enrich_[a-z0-9]+$/);
    const call = next.steps.find((s) => s.type === 'call_layer');
    expect(call).toMatchObject({ layerKey: made.key, label: 'Enrich' });
    expect(next.edges).toEqual(expect.arrayContaining([{ from: 'c0', to: call?.id }, { from: call?.id, to: 'c1' }]));
    expect(next.layers?.[made.key as string]?.trigger?.kind).toBe('layer_input');
});
