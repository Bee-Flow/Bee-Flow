/**
 * What the Flowlets sheet offers per flowlet — the web's FlowletsPanel and
 * BuildTab.handleDeleteLayer, pure: its line ("3 steps · 1 in · 2 out"), and
 * what deleting it takes. A flowlet nothing calls goes at once; an EMPTY one
 * that is called goes with its calls after asking (the palette's "Create
 * flowlet" drops a call with every new one, BFSF-340); one that is called and
 * has steps stays: deleting it would break the flows that call it.
 */

import type { TranslateFn } from '@/core/i18n';
import {
    countLayerRefs, deleteLayerAndCalls, deleteLayerFromDefinition, isLayerEmpty,
    type FlowDefinition, type LayerSummary,
} from '@/features/flow-editor/model';

export type FlowletDelete = { kind: 'now' } | { kind: 'confirm'; refs: number } | { kind: 'blocked'; refs: number };

export function flowletDelete(def: FlowDefinition | null, key: string): FlowletDelete {
    const refs = countLayerRefs(def, key);
    if (refs === 0) return { kind: 'now' };
    return isLayerEmpty(def, key) ? { kind: 'confirm', refs } : { kind: 'blocked', refs };
}

/** The edit a delete makes, or null when it is not allowed. */
export function deleteFlowletOp(key: string, how: FlowletDelete): ((d: FlowDefinition) => FlowDefinition) | null {
    if (how.kind === 'blocked') return null;
    return how.kind === 'confirm' ? (d) => deleteLayerAndCalls(d, key) : (d) => deleteLayerFromDefinition(d, key);
}

/** "3 steps · 1 in · 2 out", or that it is still empty. */
export function flowletLine(layer: LayerSummary, t: TranslateFn): string {
    if (layer.stepCount === 0) return t('mobile.flow.flowlets.empty', 'Empty flowlet — no steps yet.');
    return t('mobile.flow.flowlets.line', '{steps} steps · {inputs} in · {outputs} out', {
        steps: layer.stepCount,
        inputs: layer.params.length,
        outputs: layer.outputFields.length,
    });
}
