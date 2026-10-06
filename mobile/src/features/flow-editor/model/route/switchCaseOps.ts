/**
 * Switch-case graph surgery — a port of the web builder's
 * flow/switchCaseOps.js (node-audit C1/B1/B2), pinned by route.lockstep.test.ts.
 *
 * A switch's case names live in `step.cases[]` and its edges carry
 * `case:<name>` labels. Renaming or deleting a case must move both sides in
 * ONE definition update, or `switch.case_edge_unknown` blocks every later save.
 * Rename follows the edge; delete drops it. Pure.
 */

import { followRouteEdit, isListRoute, relabelSwitchEdges, type RouteDefinition } from '@/shared/expr';

import type { FlowDefinition, FlowStep, FlowTrigger, SwitchCase } from '../types';
import { reconcileRouteEdges } from './routeEdges';

/** A case name that does not collide with any existing case. */
export function uniqueCaseName(cases: readonly SwitchCase[] | null | undefined, base?: string): string {
    const names = new Set((Array.isArray(cases) ? cases : []).map((c) => c?.name).filter(Boolean));
    const stem = base || 'case';
    if (!names.has(stem)) return stem;
    let i = 1;
    let name = stem;
    while (names.has(name)) name = `${stem}_${++i}`;
    return name;
}

/**
 * Re-point a switch's outgoing edges (and its defaultBranch) after its cases
 * changed: the shared relabelSwitchEdges, so the phone, the canvas and the AI
 * builder agree. A case renamed in place moves its edges; a reorder moves
 * nothing; removed cases take their edges; `case:default` is never touched.
 */
export function reconcileSwitchEdges<T extends Partial<FlowDefinition> | null | undefined>(
    definition: T,
    stepId: string,
    prevCases: unknown,
    nextCases: unknown,
): T {
    return relabelSwitchEdges(definition as T & RouteDefinition, stepId, prevCases, nextCases) as T;
}

type AnyStep = (FlowStep | FlowTrigger) & { cases?: unknown };

/**
 * The steps that read a Condition's outputs follow its change (shared
 * routeFollow.mjs): a list Condition's one output becoming several re-points the connected step
 * from `items` to the first output's list, a renamed output carries its
 * readers along, a list moved one level in takes the inner `[*].<key>` off.
 */
function followRoute<T extends Partial<FlowDefinition>>(definition: T, step: AnyStep, merged: AnyStep): T {
    if (!isListRoute(step) && !isListRoute(merged)) return definition;
    return followRouteEdit(definition, step.id, step).definition as T;
}

/**
 * Merge one node's patch into the whole (scoped) definition — the single
 * implementation behind every save of a node editor. When the patch changes
 * the step's TYPE, or a switch's `cases`, the edges are healed in the SAME
 * definition object, so the save is atomic and one undo restores both — and
 * so do the references of the steps that read a Condition's outputs.
 */
export function mergeStepPatchIntoDefinition<T extends Partial<FlowDefinition>>(
    definition: T,
    step: AnyStep,
    patch: Record<string, unknown> | null | undefined,
): T {
    const merged = { ...step, ...patch, id: step.id } as AnyStep;
    let next: T = { ...definition };
    if (definition.trigger?.id === step.id) next.trigger = merged as FlowTrigger;
    else if ((definition.triggers || []).some((t) => t.id === step.id)) {
        next.triggers = (definition.triggers as FlowTrigger[]).map((t) => (t.id === step.id ? (merged as FlowTrigger) : t));
    } else {
        next.steps = (definition.steps || []).map((s) => (s.id === step.id ? (merged as FlowStep) : s));
    }
    if (patch && patch.type && patch.type !== step.type) {
        next = reconcileRouteEdges(next as T & Pick<FlowDefinition, 'edges'>, step.id, step, merged);
    } else if (step.type === 'switch' && patch && Array.isArray(patch.cases)) {
        next = reconcileSwitchEdges(next, step.id, step.cases || [], patch.cases);
    }
    return followRoute(next, step, merged);
}
