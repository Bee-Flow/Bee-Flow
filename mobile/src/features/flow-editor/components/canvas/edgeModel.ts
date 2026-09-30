/**
 * Each connection as the canvas draws it — a port of the edge half of the web
 * builder's flow/layout.js `buildLayout`, pinned by canvas.lockstep.test.ts
 * (which runs the web module on the same graphs and compares every field).
 *
 * For every definition edge: which PORT of its source it leaves by (a
 * condition's then/else, a switch's `case:<name>`, a loop's done/on_error),
 * what chip it wears (its branch, `on_error`, or `unrouted` for an unlabelled
 * line out of a brancher, which the runtime never follows), whether the port
 * already prints that name (then the line does not repeat it), the switch
 * case's slot for its automatic colour, and its lane among several lines
 * between the same two nodes. Its id is the definition row's identity, so an
 * unrelated edit never renames it.
 */

import { edgeKey, type FlowEdge } from '@/features/flow-editor/model';

/** Node types that print a name at every port they draw (StepNodeBase's sourceHandles). */
const PORT_LABELLED_TYPES: ReadonlySet<string> = new Set(['condition', 'guard', 'switch', 'loop']);

export interface EdgeNodeInfo {
    id: string;
    type?: string;
    cases?: unknown;
}

export interface ClassifiedEdge {
    id: string;
    from: string;
    to: string;
    /** The source port: then, else, case:<name>, on_error (a loop's), done (a loop's); null for the plain one. */
    sourceHandle: string | null;
    /** The chip's word (see CHIP_KINDS), a case name, or null for a plain line. */
    kind: string | null;
    /** The source's port already says `kind`; the line stays quiet. */
    labelledAtPort: boolean;
    /** The definition row's own identity and colour. */
    defLabel: string | null;
    defCaseName: string | null;
    defColor: string | null;
    /** The switch case's slot, for its automatic colour. */
    caseIndex: number | null;
    /** Several lines between the same two nodes fan out: this one's lane. */
    parallelIndex: number;
    parallelCount: number;
}

interface Routing {
    kind: string | null;
    sourceHandle: string | null;
}

/** A named branch: a condition's or guard's side, a switch case. */
function branchRouting(e: FlowEdge, fromGuard: boolean): Routing | null {
    if (e.label === 'then') return { kind: fromGuard ? 'pii_found' : 'then', sourceHandle: 'then' };
    if (e.label === 'else') return { kind: fromGuard ? 'pii_clean' : 'else', sourceHandle: 'else' };
    if (e.caseName) return { kind: e.caseName === 'default' ? 'default' : e.caseName, sourceHandle: `case:${e.caseName}` };
    if (typeof e.label === 'string' && e.label.startsWith('case:')) return { kind: e.label.slice(5), sourceHandle: e.label };
    return null;
}

function routingOf(e: FlowEdge, sourceType: string | undefined): Routing {
    const fromGuard = sourceType === 'guard';
    const branch = branchRouting(e, fromGuard);
    if (branch) return branch;
    // on_error before the loop rule: a loop's error line is not its "Done".
    if (e.label === 'on_error') return { kind: 'on_error', sourceHandle: sourceType === 'loop' ? 'on_error' : null };
    if (sourceType === 'loop') return { kind: null, sourceHandle: 'done' };
    if (e.label) return { kind: e.label, sourceHandle: null };
    const brancher = sourceType === 'condition' || sourceType === 'switch' || fromGuard;
    return { kind: brancher ? 'unrouted' : null, sourceHandle: null };
}

function caseIndexOf(e: FlowEdge, source: EdgeNodeInfo | undefined): { caseName: string | null; index: number | null } {
    const caseName = e.caseName ?? (typeof e.label === 'string' && e.label.startsWith('case:') ? e.label.slice(5) : null);
    if (!caseName || caseName === 'default' || !Array.isArray(source?.cases)) return { caseName, index: null };
    const idx = (source.cases as { name?: unknown }[]).findIndex((c) => c?.name === caseName);
    return { caseName, index: idx >= 0 ? idx : null };
}

function isPortLabelled(routing: Routing, sourceType: string | undefined, caseName: string | null, caseIndex: number | null): boolean {
    if (!routing.sourceHandle || !sourceType || !PORT_LABELLED_TYPES.has(sourceType)) return false;
    return sourceType !== 'switch' || caseName === 'default' || caseIndex !== null;
}

/**
 * The drawable edges of a graph. `nodes` is every node that can be an end
 * (inline ones too); an edge with a missing end, or the synthetic link into a
 * loop's "Each item" (`__containerEntry`), is not drawn.
 */
export function classifyEdges(nodes: readonly EdgeNodeInfo[], edges: readonly FlowEdge[] | null | undefined): ClassifiedEdge[] {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const drawn = (edges || []).filter((e) => e?.from && e?.to && !e.__containerEntry);
    const pairCounts = new Map<string, number>();
    for (const e of drawn) pairCounts.set(`${e.from}->${e.to}`, (pairCounts.get(`${e.from}->${e.to}`) || 0) + 1);
    const pairSeen = new Map<string, number>();
    const idSeen = new Map<string, number>();
    return drawn.map((e) => {
        const source = byId.get(e.from);
        const routing = routingOf(e, source?.type);
        const { caseName, index } = caseIndexOf(e, source);
        const baseId = edgeKey(e);
        const dup = idSeen.get(baseId) || 0;
        idSeen.set(baseId, dup + 1);
        const pair = `${e.from}->${e.to}`;
        const parallelIndex = pairSeen.get(pair) || 0;
        pairSeen.set(pair, parallelIndex + 1);
        return {
            id: dup ? `${baseId}#dup${dup}` : baseId,
            from: e.from,
            to: e.to,
            sourceHandle: routing.sourceHandle,
            kind: routing.kind,
            labelledAtPort: isPortLabelled(routing, source?.type, caseName, index),
            defLabel: typeof e.label === 'string' ? e.label : null,
            defCaseName: e.caseName ?? null,
            defColor: typeof e.color === 'string' ? e.color : null,
            caseIndex: index,
            parallelIndex,
            parallelCount: pairCounts.get(pair) || 1,
        };
    });
}
