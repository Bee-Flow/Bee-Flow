/**
 * The codec between an action's nested STEP TREE and the flat node + edge
 * GRAPH a canvas draws, and back again, losslessly. Port of agent-hub
 * AppStudio/flow/stepGraph.js, pinned by stepGraph.lockstep.test.ts.
 *
 * An App Studio action is a strict TREE: `stepIndex` is never stored, the
 * phone, the browser and the server each derive it by walking the saved tree
 * in the same pre-order, and the server runs the step at that index. So the
 * canvas may draw a graph, and this module keeps the graph a tree (canConnect):
 * no edge crosses a container boundary, one incoming edge per node, no cycles.
 *
 * condition -> then/else; switch -> case:<i>/case:default; loop -> its body.
 * Container children live in their own scope, addressed by a prefixed id
 * (`s2/then/s5`). Reading a scope back is a STABLE topological sort.
 *
 * Where the web returned English (branch labels, refusal reasons) the port
 * returns a Msg (core/msg); `say(msg)` renders the web's exact words.
 */

import type { Msg } from '../msg';
import type { ActionStep, AppAction } from '../types';

export const SEP = '/';
export const CONTAINER_KINDS: ReadonlySet<string> = new Set(['condition', 'loop', 'switch']);
export const ENTRY_SUFFIX = '__entry__';

export interface Scope {
    key: string;
    label: Msg;
    steps: unknown;
}

type Step = ActionStep & { id?: string };

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const LABEL_YES: Msg = { i18nKey: 'mobile.app_studio.flow.branch_yes', en: 'Yes' };
const LABEL_NO: Msg = { i18nKey: 'mobile.app_studio.flow.branch_no', en: 'No' };
const LABEL_EACH: Msg = { i18nKey: 'mobile.app_studio.flow.branch_each', en: 'For each' };
const LABEL_OTHERWISE: Msg = { i18nKey: 'mobile.app_studio.flow.branch_otherwise', en: 'Otherwise' };

/** "When it is Paid", or the position while nobody has said what it matches. */
function caseLabel(c: unknown, i: number): Msg {
    const v = (c as { value?: unknown } | null)?.value;
    if (v === '' || v === null || v === undefined) {
        return { i18nKey: 'mobile.app_studio.flow.branch_case_n', en: 'Case {n}', params: { n: i + 1 } };
    }
    return { i18nKey: 'mobile.app_studio.flow.branch_case_when', en: 'When it is {value}', params: { value: String(v) } };
}

/** The scopes a container step owns, in the FIXED order flattenSteps walks them. */
export function scopesOf(step: unknown): Scope[] {
    if (!isObject(step)) return [];
    switch (step.kind) {
        case 'condition':
            return [
                { key: 'then', label: LABEL_YES, steps: step.then },
                { key: 'else', label: LABEL_NO, steps: step.else },
            ];
        case 'loop':
            return [{ key: 'body', label: LABEL_EACH, steps: step.steps }];
        case 'switch': {
            // Keyed by POSITION: case values are author-typed and may repeat or
            // be blank, and a scope key ends up inside a node id.
            const cases = Array.isArray(step.cases) ? step.cases : [];
            return [
                ...cases.map((c, i) => ({ key: `case:${i}`, label: caseLabel(c, i), steps: (c as { steps?: unknown })?.steps })),
                { key: 'case:default', label: LABEL_OTHERWISE, steps: step.default },
            ];
        }
        default:
            return [];
    }
}

/** Write a scope's steps back onto its container, leaving the rest untouched. */
function withScope(step: Step, key: string, steps: unknown): Step {
    if (step.kind === 'condition') return { ...step, [key]: steps };
    if (step.kind === 'loop') return { ...step, steps };
    if (step.kind === 'switch') {
        if (key === 'case:default') return { ...step, default: steps };
        const at = Number(key.slice('case:'.length));
        const cases = (Array.isArray(step.cases) ? step.cases : []).map((c, i) => (i === at ? { ...c, steps } : c));
        return { ...step, cases };
    }
    return step;
}

export const makeId = (prefix: string, localId: string): string => (prefix ? `${prefix}${SEP}${localId}` : localId);

/** Split a graph id back into its container prefix and the step's own id. */
export function parseId(id: unknown): { prefix: string; localId: string } {
    const s = String(id);
    const at = s.lastIndexOf(SEP);
    if (at === -1) return { prefix: '', localId: s };
    return { prefix: s.slice(0, at), localId: s.slice(at + 1) };
}

/** Two ids are in the same scope when they share a container prefix. */
export function sameScope(a: unknown, b: unknown): boolean {
    return parseId(a).prefix === parseId(b).prefix;
}

export interface GraphNode {
    id: string;
    kind: string;
    step: Step | null;
    prefix: string;
    parentId: string | null;
    scopeKey: string | null;
    scopeLabel: Msg | null;
    isEntry: boolean;
}

export interface GraphEdge {
    id?: string;
    from: string;
    to: string;
    label?: string | null;
}

interface WalkScope {
    prefix: string;
    parentId: string | null;
    scopeKey: string | null;
    scopeLabel: Msg | null;
}

/**
 * stepsToGraph(action) -> { nodes, edges }. `isEntry` marks a container
 * scope's pill: a node the canvas draws and connects from, never a step.
 */
export function stepsToGraph(action: AppAction | ActionStep | null | undefined): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const walk = (steps: unknown, scope: WalkScope) => {
        const list = (Array.isArray(steps) ? steps : []).filter(isObject) as Step[];
        let previousId: string | null = null;
        if (scope.parentId) {
            const entryId = makeId(scope.prefix, ENTRY_SUFFIX);
            nodes.push({ id: entryId, kind: 'entry', step: null, ...scope, isEntry: true });
            previousId = entryId;
        }
        list.forEach((step, i) => {
            const id = makeId(scope.prefix, step.id || `s${i}`);
            nodes.push({ id, kind: step.kind, step, ...scope, isEntry: false });
            if (previousId) edges.push({ id: `${previousId}->${id}`, from: previousId, to: id, label: null });
            previousId = id;
            for (const s of scopesOf(step)) {
                walk(s.steps, { prefix: makeId(id, s.key), parentId: id, scopeKey: s.key, scopeLabel: s.label });
            }
        });
    };

    const root = action?.kind === 'sequence' ? (action as AppAction).steps : action ? [action] : [];
    walk(root, { prefix: '', parentId: null, scopeKey: null, scopeLabel: null });
    return { nodes, edges };
}

function edgeMaps(ids: string[], edges: readonly GraphEdge[]) {
    const set = new Set(ids);
    const indegree = new Map(ids.map((id) => [id, 0]));
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of edges) {
        if (!set.has(e.from) || !set.has(e.to) || e.from === e.to) continue;
        const targets = out.get(e.from) as string[];
        if (targets.includes(e.to)) continue; // a switch emits one edge per case
        targets.push(e.to);
        indegree.set(e.to, (indegree.get(e.to) as number) + 1);
    }
    return { set, indegree, out };
}

/**
 * Kahn's algorithm, STABLE: candidates are taken in their previous order, so
 * a node that lost its edges stays put. Leftovers (a cycle) are appended in
 * their previous order rather than dropped.
 */
export function orderScope(ids: string[], edges: readonly GraphEdge[], previousOrder: readonly string[]): string[] {
    const { set, indegree, out } = edgeMaps(ids, edges);
    const remaining = [...previousOrder.filter((id) => set.has(id)), ...ids.filter((id) => !previousOrder.includes(id))];
    const ordered: string[] = [];
    const placed = new Set<string>();
    while (remaining.length) {
        const at = remaining.findIndex((id) => indegree.get(id) === 0);
        if (at === -1) break;
        const [id] = remaining.splice(at, 1) as [string];
        ordered.push(id);
        placed.add(id);
        for (const next of out.get(id) as string[]) indegree.set(next, (indegree.get(next) as number) - 1);
    }
    for (const id of previousOrder) if (set.has(id) && !placed.has(id)) ordered.push(id);
    for (const id of ids) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
}

/** The inverse of stepsToGraph: each scope is read back from its own edges. */
export function graphToSteps(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Step[] {
    const byPrefix = new Map<string, GraphNode[]>();
    for (const node of nodes) {
        if (node.isEntry) continue;
        if (!byPrefix.has(node.prefix)) byPrefix.set(node.prefix, []);
        (byPrefix.get(node.prefix) as GraphNode[]).push(node);
    }
    const build = (prefix: string): Step[] => {
        const scoped = byPrefix.get(prefix) || [];
        if (!scoped.length) return [];
        const ids = scoped.map((n) => n.id);
        const scopeEdges = edges.filter((e) => sameScope(e.from, e.to) && parseId(e.from).prefix === prefix);
        const nodeById = new Map(scoped.map((n) => [n.id, n]));
        return orderScope(ids, scopeEdges, ids).map((id) => {
            let step = (nodeById.get(id) as GraphNode).step as Step;
            for (const scope of scopesOf(step)) step = withScope(step, scope.key, build(makeId(id, scope.key)));
            return step;
        });
    };
    return build('');
}

const reason = (key: string, en: string): { ok: false; reason: Msg } => ({
    ok: false,
    reason: { i18nKey: `mobile.app_studio.flow.${key}`, en },
});

/** May these two be connected? Every refusal keeps the graph a tree. */
export function canConnect(
    from: string,
    to: string,
    edges: readonly GraphEdge[],
    nodes: readonly GraphNode[],
): { ok: true } | { ok: false; reason: Msg } {
    if (from === to) return reason('refuse_self', 'A step cannot follow itself.');
    if (!sameScope(from, to)) return reason('refuse_scope', 'Steps can only be connected inside the same branch.');
    const target = nodes.find((n) => n.id === to);
    if (target?.isEntry) return reason('refuse_entry', 'A branch always starts at its own entry point.');
    if (edges.some((e) => e.to === to)) {
        return reason('refuse_incoming', 'A step can only follow one other step — disconnect the existing one first.');
    }
    if (edges.some((e) => e.from === from)) {
        return reason('refuse_outgoing', 'This step already leads somewhere — disconnect that first.');
    }
    if (createsCycle(from, to, edges)) return reason('refuse_cycle', 'That would loop back on itself.');
    return { ok: true };
}

/** Would adding from -> to close a loop? */
export function createsCycle(from: string, to: string, edges: readonly GraphEdge[]): boolean {
    const next = new Map<string, string[]>();
    for (const e of [...edges, { from, to }]) {
        if (!next.has(e.from)) next.set(e.from, []);
        (next.get(e.from) as string[]).push(e.to);
    }
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
        const id = stack.pop() as string;
        if (id === from) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const n of next.get(id) || []) stack.push(n);
    }
    return false;
}

/** Give every step a stable editor-only id (never persisted; see stripStepIds). */
export function withStepIds<A extends AppAction | ActionStep | null | undefined>(action: A): A {
    let counter = 0;
    const tag = (steps: unknown): Step[] =>
        ((Array.isArray(steps) ? steps : []).filter(isObject) as Step[]).map((step) => {
            counter += 1;
            let out: Step = { ...step, id: step.id || `s${counter}` };
            for (const scope of scopesOf(out)) out = withScope(out, scope.key, tag(scope.steps));
            return out;
        });
    if (!action) return action;
    if (action.kind === 'sequence') return { ...action, steps: tag((action as AppAction).steps) };
    return { ...action, id: (action as Step).id || 's1' };
}

/** Strip the editor-only ids back off before the action is saved. */
export function stripStepIds(steps: unknown): Step[] {
    return (Array.isArray(steps) ? (steps as Step[]) : []).map((step) => {
        const { id: _dropped, ...rest } = step;
        let out = rest as Step;
        for (const scope of scopesOf(out)) out = withScope(out, scope.key, stripStepIds(scope.steps));
        return out;
    });
}
