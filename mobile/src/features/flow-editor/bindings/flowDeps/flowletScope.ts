/**
 * A flowlet's contract — declared inputs and returned field names — derived
 * live from `definition.layers[key]`. Port of `getLayerContract` from agent-hub
 * `Builder/flow/flowletScope.js`. Pinned by flowDeps.lockstep.test.ts.
 */

import { arr, isObj } from '../json';
import type { FlowDefinition, TriggerParam } from '../types';

export function getLayerContract(
    def: FlowDefinition | null | undefined,
    layerKey: unknown,
): { params: TriggerParam[]; outputFields: string[] } {
    const layer = typeof layerKey === 'string' ? def?.layers?.[layerKey] : undefined;
    if (!layer) return { params: [], outputFields: [] };
    const params = arr<TriggerParam>(layer.trigger?.params);
    const out = (layer.steps || []).find((s) => s?.type === 'layer_output');
    const outputFields = isObj(out?.fields) ? Object.keys(out.fields) : [];
    return { params, outputFields };
}
