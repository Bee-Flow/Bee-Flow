/**
 * The codec between an action's nested STEP TREE and the flat node+edge GRAPH a
 * canvas draws — and back again, losslessly.
 *
 * ── WHY A TREE AND NOT A DAG ────────────────────────────────────────
 * Automations are a genuine DAG: their runner gates fan-in, so a step with two
 * incoming edges waits for both. An App Studio action is a strict TREE — one
 * parent per step, no merges, no parallelism, no back-edges — and that is not
 * an accident of the editor. `stepIndex` is never stored: the browser
 * (useActionRunner.buildStepIndexMap) and the server
 * (routes/studioAppsRun.flattenSteps) each derive it by walking the saved tree
 * in the same pre-order, and the server resolves the step to run from that
 * index alone. A graph the tree cannot express would break that agreement
 * silently, on the server, at run time.
 *
 * So the canvas is allowed to draw a graph, and this module is what keeps the
 * graph a tree. The rules it enforces on connect (see canConnect):
 *   1. no edge crosses a container boundary,
 *   2. no node has more than one incoming edge inside its scope,
 *   3. no cycles.
 *
 * ── HOW BRANCHES MAP ────────────────────────────────────────────────
 * condition → `then` / `else`; switch → `case:<index>` / `case:default`; loop →
 * its body. Each is a CONTAINER node whose children live in their own scope,
 * addressed by a prefixed id (`s2/then/s5`) — the same trick the automation
 * builder's inline flowlets use, so the ids stay flat and unique while the
 * nesting stays real.
 *
 * ── ORDERING ────────────────────────────────────────────────────────
 * Reading a scope back is a STABLE topological sort: a step that lost its edges
 * stays where it was rather than jumping to the front, and anything left over
 * (a hand-written cycle) is appended in its previous order rather than dropped.
 * Losing someone's step is worse than running it late.
 */

export const SEP = '/';

/** Steps that hold other steps, and where. */
export const CONTAINER_KINDS = new Set(['condition', 'loop', 'switch']);

/** The entry pill each container scope hangs from. */
export const ENTRY_SUFFIX = '__entry__';

import type { Translate } from '../editor/dryRunIssues';

/** One step of an action's tree. Only the container fields are read here; the rest is opaque. */
export interface FlowStep {
    id?: string;
    kind?: string;
    then?: unknown;
    else?: unknown;
    steps?: unknown;
    cases?: unknown;
    default?: unknown;
    [key: string]: unknown;
}

/** A branch of a container step: its key, its label, and its steps. */
export interface StepScope {
    key: string;
    label: string;
    steps: unknown;
}

/** A node of the flat graph: a step, or a container's entry pill. */
export interface GraphNode {
    id: string;
    kind: string | undefined;
    step: FlowStep | null;
    prefix: string;
    parentId: string | null;
    scopeKey: string | null;
    scopeLabel: string | null;
    isEntry: boolean;
}

/** An edge of the flat graph. */
export interface GraphEdge {
    id: string;
    from: string;
    to: string;
    label?: string | null;
}

function isObject(v: unknown): v is FlowStep { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Translate with `t` when there is one; otherwise the English default
 * (tests, non-React callers), interpolated the same way.
 */
const tr = (t: Translate | null, key: string, en: string, params?: Record<string, unknown>): string => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m: string, k: string) => (params && k in params ? String(params[k]) : m)));

/** "When it is Paid" — or the position, while nobody has said what it matches. */
function caseLabel(c: { value?: unknown } | null | undefined, i: number, t: Translate | null): string {
    const v = c?.value;
    if (v === '' || v === null || v === undefined) return tr(t, 'studio_apps_edit.step_graph.case_n', 'Case {n}', { n: i + 1 });
    return tr(t, 'studio_apps_edit.step_graph.when_it_is', 'When it is {value}', { value: v });
}

/**
 * The scopes a container step owns, in a FIXED order — the same order
 * flattenSteps walks, so a reader can line the two up.
 * → [{ key, label, steps }]
 */
export function scopesOf(step: unknown, t: Translate | null = null): StepScope[] {
    if (!isObject(step)) return [];
    switch (step.kind) {
        case 'condition':
            return [
                { key: 'then', label: tr(t, 'studio_apps_edit.step_graph.yes', 'Yes'), steps: step.then },
                { key: 'else', label: tr(t, 'studio_apps_edit.step_graph.no', 'No'), steps: step.else },
            ];
        case 'loop':
            return [{ key: 'body', label: tr(t, 'studio_apps_edit.step_graph.for_each', 'For each'), steps: step.steps }];
        case 'switch': {
            const cases: Array<{ value?: unknown; steps?: unknown } | null | undefined> = Array.isArray(step.cases) ? step.cases : [];
            // Keyed by POSITION, not by the case's value: canonicalize keeps
            // only { value, steps }, values are author-typed and may repeat or
            // be blank, and a scope key ends up inside a node id — so it has to
            // be unique and stable. The value is what the branch is LABELLED
            // with, which is the part a reader needs.
            return [
                ...cases.map((c, i) => ({
                    key: `case:${i}`,
                    label: caseLabel(c, i, t),
                    steps: c?.steps,
                })),
                { key: 'case:default', label: tr(t, 'studio_apps_edit.step_graph.otherwise', 'Otherwise'), steps: step.default },
            ];
        }
        default:
            return [];
    }
}

/** Write a scope's steps back onto its container, leaving the rest untouched. */
function withScope(step: FlowStep, key: string, steps: unknown): FlowStep {
    if (step.kind === 'condition') return { ...step, [key]: steps };
    if (step.kind === 'loop') return { ...step, steps };
    if (step.kind === 'switch') {
        if (key === 'case:default') return { ...step, default: steps };
        const at = Number(key.slice('case:'.length));
        const cases = (Array.isArray(step.cases) ? step.cases : []).map((c: { steps?: unknown } | null | undefined, i: number) => (
            i === at ? { ...c, steps } : c
        ));
        return { ...step, cases };
    }
    return step;
}

export const makeId = (prefix: string, localId: string): string => (prefix ? `${prefix}${SEP}${localId}` : localId);

/** Split a graph id back into its container prefix and the step's own id. */
export function parseId(id: string): { prefix: string; localId: string } {
    const at = String(id).lastIndexOf(SEP);
    if (at === -1) return { prefix: '', localId: String(id) };
    return { prefix: String(id).slice(0, at), localId: String(id).slice(at + 1) };
}

/** Two ids are in the same scope when they share a container prefix. */
export function sameScope(a: string, b: string): boolean {
    return parseId(a).prefix === parseId(b).prefix;
}

/**
 * stepsToGraph(action) → { nodes, edges }
 *
 *   node = { id, kind, step, prefix, parentId, scopeKey, scopeLabel, isEntry }
 *   edge = { id, from, to, label }
 *
 * `isEntry` marks a container scope's pill — a real node the canvas can draw
 * and connect from, but not a step: it never comes back out.
 */
export function stepsToGraph(action: FlowStep | null | undefined, t: Translate | null = null): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const walk = (steps: unknown, prefix: string, parentId: string | null, scopeKey: string | null, scopeLabel: string | null): void => {
        const list = (Array.isArray(steps) ? steps : []).filter(isObject);

        // A scope with a parent starts from that parent's pill, so an empty
        // branch is still somewhere you can drop a step.
        let previousId: string | null = null;
        if (parentId) {
            const entryId = makeId(prefix, ENTRY_SUFFIX);
            nodes.push({ id: entryId, kind: 'entry', step: null, prefix, parentId, scopeKey, scopeLabel, isEntry: true });
            previousId = entryId;
        }

        list.forEach((step, i) => {
            const id = makeId(prefix, step.id || `s${i}`);
            nodes.push({ id, kind: step.kind, step, prefix, parentId, scopeKey, scopeLabel, isEntry: false });
            if (previousId) edges.push({ id: `${previousId}->${id}`, from: previousId, to: id, label: null });
            previousId = id;

            for (const scope of scopesOf(step, t)) {
                walk(scope.steps, makeId(id, scope.key), id, scope.key, scope.label);
            }
        });
    };

    walk(action?.kind === 'sequence' ? action.steps : (action ? [action] : []), '', null, null, null);
    return { nodes, edges };
}

/**
 * Kahn's algorithm, but STABLE: candidates are taken in their previous relative
 * order, so a node that lost its edges stays where it was instead of jumping to
 * the front. A run reads the array, not the drawing — an unstable sort would
 * silently reorder a working action on an unrelated edit.
 */
export function orderScope(ids: string[], edges: Array<{ from: string; to: string }>, previousOrder: string[]): string[] {
    const set = new Set(ids);
    const indegree = new Map<string, number>(ids.map((id): [string, number] => [id, 0]));
    const out = new Map<string, string[]>(ids.map((id): [string, string[]] => [id, []]));

    for (const e of edges) {
        if (!set.has(e.from) || !set.has(e.to) || e.from === e.to) continue;
        if ((out.get(e.from) as string[]).includes(e.to)) continue;   // a switch emits one edge per case
        (out.get(e.from) as string[]).push(e.to);
        indegree.set(e.to, (indegree.get(e.to) as number) + 1);
    }

    const remaining = [...previousOrder.filter((id) => set.has(id)), ...ids.filter((id) => !previousOrder.includes(id))];
    const ordered: string[] = [];
    const placed = new Set<string>();
    while (remaining.length) {
        const at = remaining.findIndex((id) => indegree.get(id) === 0);
        if (at === -1) break;                            // a cycle — bail to the tail
        const [id] = remaining.splice(at, 1);
        ordered.push(id);
        placed.add(id);
        for (const next of out.get(id) as string[]) indegree.set(next, (indegree.get(next) as number) - 1);
    }
    // Anything left over is appended in its previous order rather than dropped.
    for (const id of previousOrder) if (set.has(id) && !placed.has(id)) ordered.push(id);
    for (const id of ids) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
}

/**
 * graphToSteps(nodes, edges) → steps
 *
 * The inverse. Container children are read back from their own scope's edges,
 * so a step dragged from one branch to another lands in the right array.
 */
export function graphToSteps(nodes: GraphNode[], edges: GraphEdge[]): FlowStep[] {
    const byPrefix = new Map<string, GraphNode[]>();
    for (const node of nodes) {
        if (node.isEntry) continue;
        if (!byPrefix.has(node.prefix)) byPrefix.set(node.prefix, []);
        (byPrefix.get(node.prefix) as GraphNode[]).push(node);
    }

    const build = (prefix: string): FlowStep[] => {
        const scoped = byPrefix.get(prefix) || [];
        if (!scoped.length) return [];
        const ids = scoped.map((n) => n.id);
        const scopeEdges = edges.filter((e) => sameScope(e.from, e.to) && parseId(e.from).prefix === prefix);
        const order = orderScope(ids, scopeEdges, ids);
        const nodeById = new Map<string, GraphNode>(scoped.map((n): [string, GraphNode] => [n.id, n]));

        return order.map((id) => {
            const node = nodeById.get(id) as GraphNode;
            let step = node.step as FlowStep;
            for (const scope of scopesOf(step)) {
                step = withScope(step, scope.key, build(makeId(id, scope.key)));
            }
            return step;
        });
    };

    return build('');
}

/**
 * May these two be connected?
 *
 * Every refusal is what keeps the graph a tree, and therefore what keeps
 * `stepIndex` meaning the same thing on both sides of the wire.
 * → { ok: true } | { ok: false, reason }
 */
export function canConnect(from: string, to: string, edges: GraphEdge[], nodes: GraphNode[], t: Translate | null = null): { ok: true } | { ok: false; reason: string } {
    if (from === to) return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.no_self', 'A step cannot follow itself.') };
    if (!sameScope(from, to)) {
        return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.same_branch', 'Steps can only be connected inside the same branch.') };
    }
    const target = nodes.find((n) => n.id === to);
    if (target?.isEntry) return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.entry_point', 'A branch always starts at its own entry point.') };
    if (edges.some((e) => e.to === to)) {
        return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.one_incoming', 'A step can only follow one other step — disconnect the existing one first.') };
    }
    if (edges.some((e) => e.from === from)) {
        return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.one_outgoing', 'This step already leads somewhere — disconnect that first.') };
    }
    if (createsCycle(from, to, edges)) {
        return { ok: false, reason: tr(t, 'studio_apps_edit.step_graph.cycle', 'That would loop back on itself.') };
    }
    return { ok: true };
}

/** Would adding from→to close a loop? */
export function createsCycle(from: string, to: string, edges: Array<{ from: string; to: string }>): boolean {
    const next = new Map<string, string[]>();
    for (const e of [...edges, { from, to }]) {
        if (!next.has(e.from)) next.set(e.from, []);
        (next.get(e.from) as string[]).push(e.to);
    }
    const seen = new Set();
    const stack: string[] = [to];
    while (stack.length) {
        const id = stack.pop() as string;
        if (id === from) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const n of next.get(id) || []) stack.push(n);
    }
    return false;
}

/**
 * Give every step in an action a stable id, so a graph node can point back at
 * exactly one step across a re-render. Steps carry no id in the schema — the
 * runtime addresses them by position — so ids are assigned here and never
 * persisted.
 */
export function withStepIds(action: FlowStep | null | undefined): FlowStep | null | undefined {
    let counter = 0;
    const tag = (steps: unknown): FlowStep[] => (Array.isArray(steps) ? steps : []).filter(isObject).map((step) => {
        counter += 1;
        let out: FlowStep = { ...step, id: step.id || `s${counter}` };
        for (const scope of scopesOf(out)) out = withScope(out, scope.key, tag(scope.steps));
        return out;
    });

    if (!action) return action;
    if (action.kind === 'sequence') return { ...action, steps: tag(action.steps) };
    return { ...action, id: action.id || 's1' };
}

/** Strip the editor-only ids back off before the action is saved. */
export function stripStepIds(steps: unknown): FlowStep[] {
    return (Array.isArray(steps) ? steps : []).map((step: FlowStep) => {
        const { id: _dropped, ...rest } = step;
        let out: FlowStep = rest;
        for (const scope of scopesOf(out)) out = withScope(out, scope.key, stripStepIds(scope.steps));
        return out;
    });
}
