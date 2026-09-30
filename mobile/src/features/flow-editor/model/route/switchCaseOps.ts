/**
 * Switch-case graph surgery — a port of the web builder's
 * flow/switchCaseOps.js (node-audit C1/B1/B2), pinned by route.lockstep.test.ts.
 *
 * A switch's case names live in `step.cases[]` and its edges carry
 * `case:<name>` labels. Renaming or deleting a case must move both sides in
 * ONE definition update, or `switch.case_edge_unknown` blocks every later save.
 * Rename follows the edge; delete drops it. Pure.
 */

import { edgeKey } from '../branchEdges';
import type { FlowDefinition, FlowEdge, FlowStep, FlowTrigger, SwitchCase } from '../types';
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

const namesOf = (cases: unknown) =>
    (Array.isArray(cases) ? (cases as SwitchCase[]) : []).map((c) => c?.name).filter((n): n is string => !!n);

function caseOf(e: FlowEdge): string | null {
    if (e.caseName != null) return e.caseName;
    if (typeof e.label === 'string' && e.label.startsWith('case:')) return e.label.slice(5);
    return null;
}

/** Positional renames (same index, new name) and the names that are gone. */
function diffCases(prev: string[], next: string[]) {
    const renames = new Map<string, string>();
    if (prev.length === next.length) {
        prev.forEach((name, i) => {
            if (name !== next[i]) renames.set(name, next[i] as string);
        });
    }
    const nextNames = new Set(next);
    const removed = new Set(prev.filter((n) => !nextNames.has(n) && !renames.has(n)));
    return { renames, removed };
}

/**
 * Re-point a switch's outgoing edges (and its defaultBranch) after its cases
 * changed. Renames are applied as ONE map in one pass (an A↔B swap cannot
 * chain); removed cases take their edges; `case:default` is never touched.
 */
export function reconcileSwitchEdges<T extends Partial<FlowDefinition> | null | undefined>(
    definition: T,
    stepId: string,
    prevCases: unknown,
    nextCases: unknown,
): T {
    if (!definition || !stepId) return definition;
    const { renames, removed } = diffCases(namesOf(prevCases), namesOf(nextCases));
    if (renames.size === 0 && removed.size === 0) return definition;

    const seen = new Set<string>();
    const edges: FlowEdge[] = [];
    for (const e of definition.edges || []) {
        let out = e;
        const name = e.from === stepId ? caseOf(e) : null;
        if (name != null && name !== 'default') {
            if (removed.has(name)) continue;
            const renamed = renames.get(name);
            if (renamed) out = { ...e, label: `case:${renamed}`, caseName: renamed };
        }
        const key = edgeKey(out);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(out);
    }

    const healStep = (s: FlowStep): FlowStep => {
        if (!s || s.id !== stepId || typeof s.defaultBranch !== 'string' || !s.defaultBranch) return s;
        if (renames.has(s.defaultBranch)) return { ...s, defaultBranch: renames.get(s.defaultBranch) };
        if (removed.has(s.defaultBranch)) return { ...s, defaultBranch: null };
        return s;
    };
    return { ...definition, edges, steps: (definition.steps || []).map(healStep) };
}

type AnyStep = (FlowStep | FlowTrigger) & { cases?: unknown };

/**
 * Merge one node's patch into the whole (scoped) definition — the single
 * implementation behind every save of a node editor. When the patch changes
 * the step's TYPE, or a switch's `cases`, the edges are healed in the SAME
 * definition object, so the save is atomic and one undo restores both.
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
    return next;
}
