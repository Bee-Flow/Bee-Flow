/**
 * The edges a loop body ACTUALLY runs along — the canvas mirror of the
 * runtime's `buildLinearEdges`, via the web builder's flow/loopBodyEdges.js
 * (pinned by loopBodyEdges.lockstep.test.ts).
 *
 * A loop body is persisted as a bare step array with no edges; the engine
 * chains it per iteration, brancher-aware:
 *   - condition → a guard: `then` continues; `else` ends this iteration;
 *   - switch    → pass-through: every declared case plus the default continues;
 *   - anything else → one plain edge.
 */

import { PORT } from './branchEdges';
import type { FlowEdge, FlowStep, SwitchCase } from './types';

/** The synthetic entry node's local id inside a loop container. */
export const LOOP_ENTRY_ID = '__item__';

type BodyStep = Pick<FlowStep, 'id' | 'type'> & { cases?: SwitchCase[] | unknown };

const bodyOf = (body: unknown): BodyStep[] =>
    (Array.isArray(body) ? body : []).filter((s): s is BodyStep => !!s && typeof s === 'object' && !!s.id);

function edgesAfter(prev: BodyStep, to: string): FlowEdge[] {
    if (prev.type === 'condition') return [{ from: prev.id, to, label: PORT.then }];
    if (prev.type !== 'switch') return [{ from: prev.id, to }];
    const cases = Array.isArray(prev.cases) ? (prev.cases as SwitchCase[]) : [];
    const out: FlowEdge[] = [];
    for (const c of cases) {
        if (c?.name) out.push({ from: prev.id, to, label: `case:${c.name}`, caseName: c.name });
    }
    out.push({ from: prev.id, to, label: PORT.defaultCaseLabel, caseName: PORT.defaultCase });
    return out;
}

/** The chain the engine runs a loop body along, starting at `entryId`. */
export function loopBodyEdges(body: unknown, entryId: string = LOOP_ENTRY_ID): FlowEdge[] {
    const steps = bodyOf(body);
    const first = steps[0];
    if (!first) return [];
    const edges: FlowEdge[] = [{ from: entryId, to: first.id }];
    for (let i = 1; i < steps.length; i++) {
        edges.push(...edgesAfter(steps[i - 1] as BodyStep, (steps[i] as BodyStep).id));
    }
    return edges;
}

/** Successor lists and indegrees over `list`, a parallel edge counted once. */
function adjacency(list: BodyStep[], edges: readonly Partial<FlowEdge>[] | null | undefined) {
    const ids = new Set(list.map((s) => s.id));
    const indegree = new Map<string, number>(list.map((s) => [s.id, 0]));
    const out = new Map<string, string[]>(list.map((s) => [s.id, []]));
    for (const e of edges || []) {
        if (!e?.from || !e?.to) continue;
        if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
        const succ = out.get(e.from) as string[];
        if (succ.includes(e.to)) continue;
        succ.push(e.to);
        indegree.set(e.to, (indegree.get(e.to) as number) + 1);
    }
    return { indegree, out };
}

/**
 * Put a loop body back in run order after its edges were rewired — the
 * inverse of `loopBodyEdges`. Stable: candidates are taken in their previous
 * relative order; anything a cycle strands is appended, never dropped.
 */
export function orderLoopBody<T extends BodyStep>(steps: T[] | null | undefined, edges?: readonly Partial<FlowEdge>[] | null): T[] {
    const list = bodyOf(steps) as T[];
    if (list.length < 2) return list;
    const { indegree, out } = adjacency(list, edges);

    const ordered: T[] = [];
    const placed = new Set<string>();
    const remaining = [...list];
    while (remaining.length) {
        const idx = remaining.findIndex((s) => indegree.get(s.id) === 0);
        if (idx === -1) break;
        const [step] = remaining.splice(idx, 1) as [T];
        ordered.push(step);
        placed.add(step.id);
        for (const next of out.get(step.id) as string[]) indegree.set(next, (indegree.get(next) as number) - 1);
    }
    for (const step of list) if (!placed.has(step.id)) ordered.push(step);
    return ordered;
}
