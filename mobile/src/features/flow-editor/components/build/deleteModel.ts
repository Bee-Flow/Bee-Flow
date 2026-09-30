/**
 * Deleting a step from the phone, without the two surprises the shared
 * delete (model/nodeOps applyDeleteNodes, the web's) has:
 *
 *   branching  a Condition or Switch whose lines go to different steps: the
 *              shared delete reconnects the step before it to EVERY branch
 *              target with a plain line, so after the delete all branches
 *              run. Here the step goes with its branch lines, and the steps
 *              it led to stay where they are, unconnected, for the author
 *              to wire as they mean it.
 *   container  a loop or a parallel group: its inside goes with it.
 *
 * Both are asked about first (deleteKindOf says which). Any other step is
 * deleted as the web deletes it: the lines around it are healed.
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import { bodyOf, branchesOf, findAtAddress, isContainer, isNestedAddress, removeStep } from '@/features/flow-editor/model/outline';

export type DeleteKind = 'plain' | 'branching' | 'container';

export function deleteKindOf(def: FlowDefinition | null, address: string): DeleteKind {
    if (!def) return 'plain';
    const step = findAtAddress(def, address);
    if (step && isContainer(step) && (bodyOf(step).length > 0 || branchesOf(step).some((b) => b.length > 0))) return 'container';
    if (isNestedAddress(address)) return 'plain';
    const targets = new Set(def.edges.filter((e) => e.from === address).map((e) => e.to));
    return targets.size > 1 ? 'branching' : 'plain';
}

/** The step removed; a branching one takes its own lines with it instead of bridging them all. */
export function deleteStep(def: FlowDefinition, address: string): FlowDefinition {
    if (deleteKindOf(def, address) !== 'branching') return removeStep(def, address);
    const edges = def.edges.filter((e) => e.from !== address);
    const removed = removeStep({ ...def, edges }, address);
    return removed.steps.length === def.steps.length ? def : removed;
}
