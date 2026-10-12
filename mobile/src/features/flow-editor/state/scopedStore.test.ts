/**
 * A flowlet edited as if it were the automation: reads are its graph, writes
 * land in the whole document as one root edit, and the view is stable while
 * nothing changes.
 */

import { createDraftStore } from './draftStore';
import { scopedDraftStore } from './scopedStore';
import { applyPatchStep, createLayerInDefinition } from '../model/index';
import type { FlowDefinition } from '../model/types';

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'call', type: 'call_layer', layerKey: 'lk' }],
    edges: [{ from: 'trg', to: 'call' }],
    layers: {
        lk: {
            title: 'Lookup',
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
            steps: [{ id: 's1', type: 'set', label: 'Tidy' }, { id: 'out', type: 'layer_output', fields: {} }],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
        },
    },
};

function stores() {
    const base = createDraftStore({
        automationId: 'a1',
        deps: { save: jest.fn(async () => ({ automation: null, warnings: [], answers: null })), create: jest.fn() },
    });
    base.getState().hydrate(DEF, 1);
    return { base, view: scopedDraftStore(base, 'lk') };
}

afterEach(() => jest.useRealTimers());

it('reads the flowlet’s graph, with the automation’s flowlets beside it', () => {
    const { view } = stores();
    const def = view.getState().definition;
    expect(def?.trigger?.kind).toBe('layer_input');
    expect(def?.steps.map((s) => s.id)).toEqual(['s1', 'out']);
    expect(Object.keys(def?.layers || {})).toEqual(['lk']);
    expect(view.getState()).toBe(view.getState());
});

it('writes an edit into the whole document as one undoable edit', () => {
    jest.useFakeTimers();
    const { base, view } = stores();
    const listener = jest.fn();
    const off = view.subscribe(listener);
    view.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'Tidy up' }) as FlowDefinition);
    const root = base.getState().definition as FlowDefinition;
    expect(root.layers?.lk?.steps[0]?.label).toBe('Tidy up');
    expect(root.layers?.lk?.layers).toBeUndefined();
    expect(root.steps).toEqual(DEF.steps);
    expect(view.getState().definition?.steps[0]?.label).toBe('Tidy up');
    expect(listener).toHaveBeenCalled();
    base.getState().undo();
    expect(view.getState().definition?.steps[0]?.label).toBe('Tidy');
    off();
    base.getState().dispose();
});

it('puts a flowlet created from inside one on the automation’s own map', () => {
    jest.useFakeTimers();
    const { base, view } = stores();
    view.getState().applyOp((d) => createLayerInDefinition(d, 'Inner', () => 'ab').definition);
    const layers = base.getState().definition?.layers || {};
    expect(Object.keys(layers).sort()).toEqual(['inner_ab', 'lk']);
    expect(layers.lk?.steps.map((s) => s.id)).toEqual(['s1', 'out']);
    base.getState().dispose();
});
