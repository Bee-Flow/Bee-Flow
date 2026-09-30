/**
 * A step the node editor opens by ADDRESS, not only by id — pure.
 *
 * The build screen's outline shows a loop's body and a parallel step's
 * branches as groups of their own, and opens a held step at its address
 * (outline/nested.ts: the ids down to it, `loop_1/b_set`). Held steps carry no
 * edges — the engine chains a body or a branch in order — so they are absent
 * from the flow's run order and from its upstream walk. These answer the two
 * questions the editor asks of an address instead:
 *
 *   upstreamGroupsAt  what the step can bind to. A body step sees what its
 *                     loop sees, the current item, and the body steps before
 *                     it — the web's LoopBodyEditor feeds its nested forms
 *                     exactly `computeLoopBodyGroups(loop, i, loopGroups,
 *                     loopSampleRoot, …)`. A branch step sees what its
 *                     parallel step sees and the branch's earlier steps.
 *   positionAt        where it sits, for the header's paging: its place in the
 *                     list that holds it, so paging walks the body in order.
 */

import {
    buildSampleRoot,
    buildToolOutputMap,
    computeLoopBodyGroups,
    computeUpstreamGroups,
    describeNode,
    type FlowNode,
    type VariableGroup,
} from '@/features/flow-editor/bindings';
import { flowPosition, type FlowDefinition, type FlowPosition } from '@/features/flow-editor/model';
import { childAddress, findAtAddress, inlineList, inlineSpot, isNestedAddress } from '@/features/flow-editor/model/outline';

type Catalog = Parameters<typeof computeUpstreamGroups>[2];
type RealOutputs = Parameters<typeof computeUpstreamGroups>[3];

export { isNestedAddress };

/** The groups the step at `address` can bind to. */
export function upstreamGroupsAt(
    definition: FlowDefinition,
    address: string,
    catalog: Catalog,
    real: RealOutputs = null,
): VariableGroup[] {
    if (!isNestedAddress(address)) return computeUpstreamGroups(definition, address, catalog, real);
    const spot = inlineSpot(definition, address);
    const holder = spot ? findAtAddress(definition, spot.container) : null;
    if (!spot || !holder) return [];
    const outer = upstreamGroupsAt(definition, spot.container, catalog, real);
    if (spot.branch === null) {
        return computeLoopBodyGroups(holder as FlowNode, spot.index, {
            outerGroups: outer,
            previewSample: buildSampleRoot(outer),
            catalog,
            definition,
        });
    }
    const toolToOutput = buildToolOutputMap(catalog);
    const earlier = inlineList(holder, spot.branch)
        .slice(0, spot.index)
        .map((s) => describeNode(s as FlowNode, { definition, toolToOutput, triggerOutputs: {} }))
        .filter((g): g is VariableGroup => !!g);
    return [...outer, ...earlier];
}

/** Where the step at `address` sits: in the run order, or in the list that holds it. */
export function positionAt(definition: FlowDefinition, address: string): FlowPosition {
    if (!isNestedAddress(address)) return flowPosition(definition, address);
    const spot = inlineSpot(definition, address);
    const holder = spot ? findAtAddress(definition, spot.container) : null;
    if (!spot || !holder) return { index: 0, total: 0, prevId: null, nextId: null };
    const list = inlineList(holder, spot.branch);
    const at = (i: number) => {
        const step = list[i];
        return step ? childAddress(spot.container, step.id) : null;
    };
    return { index: spot.index + 1, total: list.length, prevId: at(spot.index - 1), nextId: at(spot.index + 1) };
}
