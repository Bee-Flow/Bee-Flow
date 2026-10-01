/**
 * Auto-map for a step that runs once per item: its own item is the nearest
 * source, so its empty inputs are matched to the item's fields first — an
 * `each` pick under a `repeat`, a `loop.<itemVar>` ref under the older
 * forEach. Auto-map never switches a per-item run ON (that is the author's
 * call, in the step's settings).
 *
 * The rule itself (which fields the item offers, what a match is written as)
 * is the shared core's (match.mjs itemMatchScope / matchFromItem), the one
 * the web's auto-map calls too. Only the item's sample is worked out here.
 */

import { itemMatchScope, matchFromItem } from '@/shared/mapping';

import { emptyInputs } from './autoMap';
import { buildSampleRoot } from './realOutputs';
import type { Binding, Catalog, FlowDefinition, FlowNode, JsonSchema, VariableGroup } from './types';
import { buildToolOutputMap, inferLoopItemSample } from './upstream';

/** Where the step sits: the definition and the catalog its tools come from. */
export interface IterationContext {
    definition: FlowDefinition;
    catalog: Catalog | null | undefined;
}

export interface ItemMapping {
    patch: Record<string, Binding>;
    /** The upstream group that offers the same item as `loop.<itemVar>.*`, if any. */
    groupId: string | null;
}

/**
 * The empty inputs of a repeating step, bound from its current item: each
 * item field once at most, `<entity>Id` to the item's own `id` (once), and a
 * name a fan-out entry has under output AND item left for the author. Null
 * when the step does not repeat.
 */
export function mapFromItem(
    step: FlowNode,
    schema: JsonSchema | null | undefined,
    groups: VariableGroup[],
    { definition, catalog }: IterationContext,
): ItemMapping | null {
    const toolToOutput = buildToolOutputMap(catalog);
    const sampleRoot = buildSampleRoot(groups);
    const scope = itemMatchScope(step, definition, (listPath) => inferLoopItemSample(listPath, definition, toolToOutput, sampleRoot));
    if (!scope) return null;
    const patch = matchFromItem(scope, emptyInputs(schema, step.inputs || {})) as unknown as Record<string, Binding>;
    return { patch, groupId: scope.groupId };
}
