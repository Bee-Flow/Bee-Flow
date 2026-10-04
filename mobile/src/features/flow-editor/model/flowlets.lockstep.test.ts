/**
 * DIFFERENTIAL lockstep: the flowlet helpers against the web's own
 * flowletScope.js, required from agent-hub and run on the same definitions
 * — an automation with flowlets calling each other, called from the root, from a
 * loop body and from a parallel branch.
 */

import * as port from './flowlets';
import type { FlowDefinition } from './types';

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const web = require(`${FLOW}/flowletScope.js`);
/* eslint-enable @typescript-eslint/no-require-imports */

const layer = (title: string, steps: FlowDefinition['steps'], edges: FlowDefinition['edges'] = []): FlowDefinition => ({
    title,
    trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'q', type: 'string' }] },
    steps,
    edges,
});

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'a', type: 'set' },
        { id: 'call1', type: 'call_layer', layerKey: 'lookup' },
        { id: 'b', type: 'notification' },
        { id: 'lp', type: 'loop', body: [{ id: 'inner', type: 'call_layer', layerKey: 'lookup' }] },
        { id: 'par', type: 'parallel', branches: [[{ id: 'p1', type: 'call_layer', layerKey: 'tidy' }], { steps: [{ id: 'p2', type: 'call_layer', layerKey: 'lookup' }] }] as never },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'call1' }, { from: 'call1', to: 'b' }, { from: 'b', to: 'lp' }, { from: 'lp', to: 'par' }],
    layers: {
        lookup: layer('Lookup', [{ id: 'c2', type: 'call_layer', layerKey: 'tidy' }, { id: 'out', type: 'layer_output', fields: { x: 1 } }], [{ from: 'trg', to: 'c2' }, { from: 'c2', to: 'out' }]),
        tidy: layer('Tidy', [{ id: 'out', type: 'layer_output', fields: {} }], [{ from: 'trg', to: 'out' }]),
        empty: layer('', [{ id: 'out', type: 'layer_output', fields: {} }]),
    },
};

const same = (fn: string, ...args: unknown[]) =>
    expect(JSON.parse(JSON.stringify((port as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]?.(...args) ?? null))).toEqual(
        JSON.parse(JSON.stringify(web[fn](...args) ?? null)),
    );

describe('flowlets, beside the web', () => {
    it('reads and writes a scope', () => {
        for (const key of [null, 'lookup', 'gone']) same('getScopedGraph', DEF, key);
        same('getScopedGraph', null, 'lookup');
        same('setScopedGraph', DEF, 'tidy', { steps: [], edges: [] });
        same('setScopedGraph', DEF, null, { steps: [], edges: [] });
    });

    it('lists, counts and finds who calls whom', () => {
        same('listLayers', DEF);
        same('listLayers', null);
        for (const key of ['lookup', 'tidy', 'empty', 'gone']) {
            same('countLayerRefs', DEF, key);
            same('isLayerEmpty', DEF, key);
            expect([...port.layerKeysThatReach(DEF, key)].sort()).toEqual([...web.layerKeysThatReach(DEF, key)].sort());
        }
    });

    it('deletes a flowlet with every call to it, and renames one', () => {
        for (const key of ['lookup', 'tidy', 'empty']) {
            same('deleteLayerAndCalls', DEF, key);
            same('deleteLayerFromDefinition', DEF, key);
        }
        same('renameLayer', DEF, 'tidy', 'Tidy up');
        same('renameLayer', DEF, 'gone', 'x');
    });

    it('creates the web’s skeleton under a key slugged from the title', () => {
        const mine = port.createLayerInDefinition(DEF, 'Enrich contact!', () => 'ab12');
        const theirs = web.createLayerInDefinition(DEF, 'Enrich contact!');
        expect(mine.layerKey).toBe('enrich_contact_ab12');
        expect(theirs.layerKey).toMatch(/^enrich_contact_[a-z0-9]{4}$/);
        expect(mine.definition.layers?.[mine.layerKey]).toEqual(theirs.definition.layers[theirs.layerKey]);
        expect(mine.definition.schemaVersion).toBe(2);
        expect(port.createLayerInDefinition(null, '123', () => 'zz').layerKey).toBe('layer_123_zz');
    });
});
