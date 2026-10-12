/**
 * Switch-case graph surgery (node-audit C1/B1/B2).
 *
 * A switch's cases and its edges live in different places — `step.cases[]`
 * holds the names, `definition.edges[]` carries `case:<name>` labels — and the
 * case editor only ever wrote the FIRST side. Renaming or deleting a case
 * therefore orphaned its edges, and `switch.case_edge_unknown` is a blocking
 * (integrity) validation error, so every subsequent save of the WHOLE automation
 * 400'd until the user hand-repaired the JSON. These transforms keep both
 * sides in one atomic definition update: rename follows the edge, delete drops
 * it ("heal, don't block" — same philosophy as applyDeleteNodes).
 *
 * Everything here is pure; inputs are never mutated.
 */

import { followRouteEdit, isListRoute, relabelSwitchEdges } from '@shared/expr/routeFollow.mjs';
import { reconcileRouteEdges } from './routeEdges';

/**
 * Mint a case name that doesn't collide with any existing case.
 *
 * Extracted from the "Add case for <sample>" button, which already did this
 * right, while the plain "Add case" button minted `case${cases.length + 1}` —
 * a name that collides as soon as a case is removed from the middle
 * (add/add/remove-first/add ⇒ two `case2`s ⇒ blocking
 * `switch.case_name_duplicate` + two React Flow ports with the same handle
 * id, of which only the first is reachable).
 */
export function uniqueCaseName(cases, base) {
    const names = new Set((Array.isArray(cases) ? cases : []).map(c => c?.name).filter(Boolean));
    const stem = base || 'case';
    if (!names.has(stem)) return stem;
    let i = 1;
    let name = stem;
    while (names.has(name)) name = `${stem}_${++i}`;
    return name;
}

/**
 * Re-point a switch's outgoing edges (and its defaultBranch) after its cases
 * changed: the shared relabelSwitchEdges (shared/expr/routeFollow.mjs), so
 * the canvas, the phone and the AI builder agree, and followRouteEdit moves
 * the steps that read an output by the very same rule.
 *
 * - A rename is a case whose name changed in place (same index, same number
 *   of cases, old name gone, new name new); its edges take the new name.
 *   A reorder moves nothing: each edge stays on its own output.
 * - Removed cases take their edges with them.
 * - `case:default` edges are never touched.
 * - Legacy edge shapes (label-only `case:x`, caseName-only `x`) are healed to
 *   the canonical both-fields form when renamed.
 * - `defaultBranch` follows a rename and is cleared when its case is removed.
 *
 * @param {object} definition  whole (scoped) graph
 * @param {string} stepId      the switch step id
 * @param {Array}  prevCases   cases BEFORE the edit ([{name, value}])
 * @param {Array}  nextCases   cases AFTER the edit
 * @returns {object} next definition (same object when nothing had to change)
 */
export function reconcileSwitchEdges(definition, stepId, prevCases, nextCases) {
    return relabelSwitchEdges(definition, stepId, prevCases, nextCases);
}

/**
 * Merge one node's patch into the whole (scoped) definition — the single
 * shared implementation behind NodeDetailView's save path AND its
 * unmount-flush, which used to duplicate this logic.
 *
 * When the patched step is a switch whose `cases` changed, the edge/default
 * reconcile above rides along IN THE SAME definition object, so the PUT is
 * atomic: `switch.case_edge_unknown` can never fire on a rename, and undo
 * restores the rename and the healed edges together. The same goes for the
 * steps that read a list Condition's outputs (W3-W5).
 */
export function mergeStepPatchIntoDefinition(definition, step, patch) {
    const merged = { ...step, ...patch, id: step.id };
    let next = { ...definition };
    if (definition.trigger?.id === step.id) next.trigger = merged;
    // Secondary triggers (definition.triggers[]) must patch back into THAT
    // array, not steps[] — a trigger-shaped object has no `type` the step
    // validator accepts.
    else if ((definition.triggers || []).some(t => t.id === step.id)) {
        next.triggers = definition.triggers.map(t => (t.id === step.id ? merged : t));
    } else {
        next.steps = (definition.steps || []).map(s => (s.id === step.id ? merged : s));
    }

    // The unified Condition editor can change the step's TYPE (adding a
    // second rule to an If makes it a Switch; "work through a list" makes it a
    // Filter). That renames every output port, so the edges are re-pointed in
    // the SAME commit — otherwise the very next save would 400 on
    // `switch.case_edge_unknown`, exactly like the case-rename bug did (C1).
    if (patch && patch.type && patch.type !== step.type) {
        next = reconcileRouteEdges(next, step.id, step, merged);
    } else if (step.type === 'switch' && patch && Array.isArray(patch.cases)) {
        next = reconcileSwitchEdges(next, step.id, step.cases || [], patch.cases);
    }
    // A Condition that works through a list hands its OUTPUTS on: when one
    // output becomes several, an output is renamed or the list goes one level
    // deeper, the steps reading an output follow it in this same commit
    // (shared/expr/routeFollow.mjs), so undo takes back both.
    if (isListRoute(step) || isListRoute(merged)) {
        next = followRouteEdit(next, step.id, step).definition;
    }
    return next;
}
