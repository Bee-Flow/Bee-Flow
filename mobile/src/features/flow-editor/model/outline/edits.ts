/**
 * The outline's card actions as pure edits: remove, duplicate, detach, move
 * up/down and pin, for a wired step (graph surgery: the model's nodeOps, the
 * same functions the web canvas calls) and for a held one (list surgery on a
 * loop body or a parallel branch).
 *
 * Move is the phone's own: the canvas reorders by dragging a position, and an
 * outline cannot. Moving a card swaps it with its neighbour by rewriting the
 * edges between them — only where that is unambiguous (a straight run of
 * plain edges), never through a branch or a join — and never above a step
 * whose output it reads: it would run first and read nothing (the server's
 * `ref.forward`).
 */

import {
    applyDeleteNodes, applyDetachNode, applyDuplicateNode, applyPatchStep, copyExtraEdgeKeys, isTerminalStep, PORT, uniqueStepId,
    type FlowDefinition, type FlowEdge, type FlowStep,
} from '..';
import { allIds, childAddress, findAtAddress, findNode, inlineList, inlineSpot, isNestedAddress, leafId, updateAtAddress, withInlineList } from './nested';
import { stepsReadBy } from './stepRefs';

/** A plain continuation: no branch label (a `caseName` alone still names a switch branch). */
const isMain = (e: FlowEdge) => (!e.label && e.caseName == null) || e.label === 'on_success';
const notError = (e: FlowEdge) => e.label !== PORT.onError;

/** Does `step` read `sourceId`'s output anywhere in its settings? */
function readsFrom(step: unknown, sourceId: string): boolean {
    return stepsReadBy(step).has(sourceId);
}

function nodeType(def: FlowDefinition, id: string): string | null {
    return findNode(def, id)?.type ?? null;
}

/**
 * `upper → lower` can be swapped when it is a straight run: one plain edge
 * between them, nothing else leaves `upper`, nothing else enters `lower`,
 * and `lower` leaves only by plain edges (a branch cannot move above
 * something). Neither is a trigger, `lower` is not a step that ends the run
 * (it would end it before `upper` ever ran), and `lower` does not read
 * `upper`'s output.
 */
function canSwap(def: FlowDefinition, upper: string, lower: string): boolean {
    const types = [nodeType(def, upper), nodeType(def, lower)];
    if (types.some((t) => !t || t === 'trigger' || t === 'note')) return false;
    if (isTerminalStep({ type: types[1] })) return false;
    if (readsFrom(def.steps.find((s) => s.id === lower), upper)) return false;
    const upperOut = def.edges.filter((e) => e.from === upper && notError(e));
    const lowerIn = def.edges.filter((e) => e.to === lower);
    const lowerOut = def.edges.filter((e) => e.from === lower && notError(e));
    const link = upperOut[0];
    return upperOut.length === 1 && !!link && link.to === lower && isMain(link) && lowerIn.length === 1 && lowerOut.every(isMain);
}

/** Swap two wired neighbours: what came into `upper` now comes into `lower`, and so on. */
function swapWired(def: FlowDefinition, upper: string, lower: string): FlowDefinition {
    const edges = def.edges.map((e): FlowEdge => {
        if (e.from === upper && e.to === lower) return copyExtraEdgeKeys(e, { from: lower, to: upper });
        if (e.to === upper) return { ...e, to: lower };
        if (e.from === lower && notError(e)) return { ...e, from: upper };
        return e;
    });
    return { ...def, edges };
}

/** The one plain predecessor of a wired step, when there is exactly one. */
function soleMainNeighbour(def: FlowDefinition, id: string, dir: 'up' | 'down'): string | null {
    const list = def.edges.filter((e) => (dir === 'up' ? e.to === id : e.from === id) && notError(e));
    const only = list.length === 1 ? list[0] : undefined;
    return only && isMain(only) ? (dir === 'up' ? only.from : only.to) : null;
}

export type MoveDirection = 'up' | 'down';

function inlineMoveTarget(def: FlowDefinition, address: string, dir: MoveDirection): number | null {
    const spot = inlineSpot(def, address);
    if (!spot) return null;
    const to = dir === 'up' ? spot.index - 1 : spot.index + 1;
    if (to < 0 || to >= spot.length) return null;
    const list = inlineList(findAtAddress(def, spot.container), spot.branch);
    const [upper, lower] = dir === 'up' ? [list[to], list[spot.index]] : [list[spot.index], list[to]];
    return upper && readsFrom(lower, upper.id) ? null : to;
}

/** Can this card move one place up or down? */
export function canMove(def: FlowDefinition, address: string, dir: MoveDirection): boolean {
    if (isNestedAddress(address)) return inlineMoveTarget(def, address, dir) !== null;
    const other = soleMainNeighbour(def, address, dir);
    if (!other) return false;
    return dir === 'up' ? canSwap(def, other, address) : canSwap(def, address, other);
}

function moveInline(def: FlowDefinition, address: string, dir: MoveDirection): FlowDefinition {
    const spot = inlineSpot(def, address);
    const to = inlineMoveTarget(def, address, dir);
    if (!spot || to === null) return def;
    return updateAtAddress(def, spot.container, (container) => {
        const list = inlineList(container, spot.branch).slice();
        const [item] = list.splice(spot.index, 1);
        list.splice(to, 0, item as FlowStep);
        return withInlineList(container, spot.branch, list);
    });
}

/** The definition with the card moved; the same definition when it cannot move. */
export function moveStep(def: FlowDefinition, address: string, dir: MoveDirection): FlowDefinition {
    if (!canMove(def, address, dir)) return def;
    if (isNestedAddress(address)) return moveInline(def, address, dir);
    const other = soleMainNeighbour(def, address, dir) as string;
    return dir === 'up' ? swapWired(def, other, address) : swapWired(def, address, other);
}

function removeInline(def: FlowDefinition, address: string): FlowDefinition {
    const spot = inlineSpot(def, address);
    if (!spot) return def;
    return updateAtAddress(def, spot.container, (container) =>
        withInlineList(container, spot.branch, inlineList(container, spot.branch).filter((_, i) => i !== spot.index)),
    );
}

/** Remove a card: a wired step heals the chain around it (bridgeEdges); the primary trigger stays. */
export function removeStep(def: FlowDefinition, address: string): FlowDefinition {
    if (isNestedAddress(address)) return removeInline(def, address);
    return applyDeleteNodes(def, address) as FlowDefinition;
}

const COPY_SUFFIX = ' (copy)';

/** A held step's copy, right after it — a body runs in order, so a copy goes next in line. */
function duplicateInline(def: FlowDefinition, address: string): { definition: FlowDefinition; address: string | null } {
    const spot = inlineSpot(def, address);
    const source = findAtAddress(def, address);
    if (!spot || !source) return { definition: def, address: null };
    const clone = JSON.parse(JSON.stringify(source)) as FlowStep;
    clone.id = uniqueStepId(source.type, allIds(def));
    clone.label = `${source.label || source.type || 'Step'}${COPY_SUFFIX}`;
    delete clone.pinnedOutput;
    delete clone.pinnedAt;
    delete clone.pinnedSource;
    const definition = updateAtAddress(def, spot.container, (container) => {
        const list = inlineList(container, spot.branch).slice();
        list.splice(spot.index + 1, 0, clone);
        return withInlineList(container, spot.branch, list);
    });
    return { definition, address: childAddress(spot.container, clone.id) };
}

/** Duplicate a card: a wired step's copy is a sibling off the same predecessors (the web's rule). */
export function duplicateStep(def: FlowDefinition, address: string): { definition: FlowDefinition; address: string | null } {
    if (isNestedAddress(address)) return duplicateInline(def, address);
    const { definition, newStepId } = applyDuplicateNode(def, address);
    return { definition: definition as FlowDefinition, address: newStepId };
}

/** Take a wired step out of the flow without deleting it. Held steps have no wiring. */
export function detachStep(def: FlowDefinition, address: string): FlowDefinition {
    if (isNestedAddress(address)) return def;
    return applyDetachNode(def, address) as FlowDefinition;
}

/** A pinned output freezes what a step hands on; null/undefined is "not pinned". */
export function isPinned(step: { pinnedOutput?: unknown } | null | undefined): boolean {
    return step?.pinnedOutput !== undefined && step?.pinnedOutput !== null;
}

/**
 * Pin a step's last output, or release its pin — exactly the patch the web
 * card and the node editor write (DiagramPane.jsx onPinNode): `pinnedSource`
 * is left unset on both paths; only the output editor calls a pin "edited".
 */
export function togglePin(def: FlowDefinition, address: string, output: unknown, now: Date = new Date()): FlowDefinition {
    const step = findAtAddress(def, address);
    if (!step) return def;
    const patch = isPinned(step)
        ? { pinnedOutput: null, pinnedAt: null, pinnedSource: undefined }
        : output === undefined
            ? null
            : { pinnedOutput: output, pinnedAt: now.toISOString(), pinnedSource: undefined };
    if (!patch) return def;
    if (!isNestedAddress(address)) return applyPatchStep(def, address, patch) as FlowDefinition;
    return updateAtAddress(def, address, (s) => ({ ...s, ...patch }));
}

/** Skipped by the runner (it passes its input through) — the web node editor's Disable. */
export function isDisabled(step: object | null | undefined): boolean {
    return (step as { disabled?: unknown } | null | undefined)?.disabled === true;
}

/**
 * Switch a step off or back on — the patch the web node editor writes
 * (NodeDetailView's `persistStepPatch({ disabled: !step.disabled })`). Never a
 * trigger: the runner's check sits where the entry trigger never goes.
 */
export function toggleDisabled(def: FlowDefinition, address: string): FlowDefinition {
    const step = findAtAddress(def, address);
    if (!step) return def;
    const patch = { disabled: !isDisabled(step) };
    if (!isNestedAddress(address)) return applyPatchStep(def, address, patch) as FlowDefinition;
    return updateAtAddress(def, address, (s) => ({ ...s, ...patch }));
}

/** The step id an address names (the last segment). */
export const stepIdOf = leafId;
