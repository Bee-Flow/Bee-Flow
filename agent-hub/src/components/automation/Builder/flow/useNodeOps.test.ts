import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { composeInlineGraph, decomposeInlineGraph } from './inlineFlowlets';
import { useNodeOps, type NodeOpsInputs } from './useNodeOps';
import type { DiagramDefinition } from './diagramPaneTypes';
import type { ScopeGraph } from './flowletScope';
import type { FlowDefinition, FlowStep } from './types';

/** A root flow calling one flowlet, and looping over a list, both drawn open on the canvas. */
const root = (): ScopeGraph => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'cl1', type: 'call_layer', layerKey: 'enrich', position: { x: 300, y: 0 } },
        {
            id: 'lp1', type: 'loop', overRef: 'trigger.output.items', position: { x: 600, y: 0 },
            body: [{ id: 'act_in', type: 'integration_action', tool: 'x.y' }],
        },
    ],
    edges: [{ from: 'trg', to: 'cl1' }, { from: 'cl1', to: 'lp1' }],
    layers: {
        enrich: {
            title: 'Enrich',
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
            steps: [{ id: 's1', type: 'ai_step', prompt: 'x' }, { id: 'out', type: 'layer_output', fields: {} }],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
        },
    },
} as unknown as ScopeGraph);

function setup(expanded: string[]) {
    const def = root();
    const { graph, sidecar } = composeInlineGraph(def, def, new Set(expanded));
    const inlineTriggerIds = new Set([...sidecar.values()].map(e => e.triggerId).filter(Boolean) as string[]);
    const onDefinitionChange = vi.fn();
    const inputs: NodeOpsInputs = {
        definition: graph as DiagramDefinition,
        editable: true,
        structuralEditsBlocked: false,
        onDefinitionChange,
        catalog: null,
        realOutputById: null,
        autoMapEnabled: false,
        onAutoMapped: null,
        inlineTriggerIds,
    };
    const { result } = renderHook(() => useNodeOps(inputs, new Map()));
    return { ops: result.current, onDefinitionChange, sidecar, def };
}

describe('useNodeOps: an expanded container\'s entry node is a trigger', () => {
    it('does not duplicate a flowlet\'s layer_input (it would be saved as a second trigger step)', () => {
        const { ops, onDefinitionChange } = setup(['cl1']);
        ops.onDuplicateNode('cl1/trg');
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });

    it('does not duplicate a loop\'s "Each item" pill (it would be saved as a loop_item step)', () => {
        const { ops, onDefinitionChange } = setup(['lp1']);
        ops.onDuplicateNode('lp1/__item__');
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });

    it('does not detach a flowlet\'s layer_input (its steps would lose their entry)', () => {
        const { ops, onDefinitionChange } = setup(['cl1']);
        ops.onDetachNode('cl1/trg');
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });

    it('still duplicates an ordinary step inside the flowlet, into that flowlet', () => {
        const { ops, onDefinitionChange, sidecar } = setup(['cl1']);
        ops.onDuplicateNode('cl1/s1');
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        const { layerPatches } = decomposeInlineGraph(onDefinitionChange.mock.calls[0][0] as FlowDefinition, sidecar);
        const layer = (layerPatches as Record<string, FlowDefinition>).enrich;
        expect(layer.steps?.filter(s => s.type === 'ai_step')).toHaveLength(2);
        expect(layer.steps?.some(s => s.type === 'trigger')).toBe(false);
    });
});

describe('useNodeOps: duplicating a loop', () => {
    it('gives the copy\'s body steps ids of their own', () => {
        const { ops, onDefinitionChange } = setup([]);
        ops.onDuplicateNode('lp1');
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        const next = onDefinitionChange.mock.calls[0][0] as FlowDefinition;
        const loops = (next.steps || []).filter(s => s.type === 'loop') as Array<FlowStep & { body: FlowStep[] }>;
        expect(loops).toHaveLength(2);
        expect(loops[0].body[0].id).toBe('act_in');
        expect(loops[1].body[0].id).not.toBe('act_in');
        expect(loops[1].body[0].tool).toBe('x.y');
    });
});
