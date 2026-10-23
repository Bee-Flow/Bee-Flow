import type { DiagramDefinition } from './diagramPaneTypes';
import type { FlowDefinition } from './types';

interface StepLike { id?: string; type?: string; [key: string]: unknown }
interface EdgeLike { from?: string; to?: string }
interface DefinitionLike {
    trigger?: StepLike | null;
    triggers?: StepLike[];
    steps?: StepLike[];
    edges?: EdgeLike[];
}
/**
 * The steps of a graph in the order they RUN.
 *
 * Nothing else could answer this. `mapping/upstream.js` walks backwards from
 * one step; `flow/layout.js` skips dagre entirely once every node has a saved
 * position, so its output carries no ordering; and `definition.steps[]` is
 * authoring order — the order things were dropped on the canvas, which is
 * rarely the order they execute in. The full-screen node editor needs a
 * sequence to page through and a position to report ("step 3 of 7"), so it
 * gets one here (BFSF-332).
 *
 * Kahn over `edges`, seeded from the trigger(s). Deliberate properties:
 *   - deterministic: ties break on edge order first, then `steps[]` index, so
 *     the same graph always yields the same sequence and the indicator never
 *     jumps around between renders;
 *   - total: nodes a cycle or a missing edge leaves unreachable are appended
 *     in `steps[]` order rather than dropped, so every node is reachable by
 *     paging and the count matches what the canvas shows;
 *   - shallow: loop bodies and parallel branches are not descended into. They
 *     are edited inside their parent's own editor, and the NDV opens on the
 *     parent — a nested step is not a page of this book.
 */
export function flowOrder(definition: DiagramDefinition | DefinitionLike | null | undefined) {
    const steps = Array.isArray(definition?.steps) ? definition.steps.filter(Boolean) : [];
    const roots = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])]
        .filter(t => t && t.id);

    const nodes = [...roots, ...steps];
    const index = new Map();
    nodes.forEach((n, i) => { if (n?.id != null && !index.has(n.id)) index.set(n.id, i); });
    if (index.size === 0) return [];

    const edges = (Array.isArray(definition?.edges) ? definition.edges : [])
        .filter((e: EdgeLike) => e && index.has(e.from) && index.has(e.to));

    const outgoing = new Map();
    const indegree = new Map([...index.keys()].map(id => [id, 0]));
    edges.forEach((e: EdgeLike, order: number) => {
        if (!outgoing.has(e.from)) outgoing.set(e.from, []);
        outgoing.get(e.from).push({ to: e.to, order });
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
    });

    // Ready set kept sorted by (declaration index) so the walk is stable; the
    // trigger sits at index 0 and therefore always leads.
    const ready = [...index.keys()].filter(id => (indegree.get(id) || 0) === 0);
    const byIndex = (a: string, b: string) => index.get(a) - index.get(b);
    ready.sort(byIndex);

    const out = [];
    const seen = new Set();
    while (ready.length) {
        const id = ready.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        const next = (outgoing.get(id) || []).slice().sort((a: { order: number; }, b: { order: number; }) => a.order - b.order);
        for (const { to } of next) {
            const left = (indegree.get(to) || 0) - 1;
            indegree.set(to, left);
            if (left <= 0 && !seen.has(to)) {
                ready.push(to);
                ready.sort(byIndex);
            }
        }
    }

    // Whatever a cycle left behind, in authoring order.
    for (const id of index.keys()) if (!seen.has(id)) out.push(id);
    return out;
}

/**
 * `{ index, total, prevId, nextId }` for one step within its graph — the shape
 * the node editor's paging controls need. `index` is 1-based for display;
 * `prevId`/`nextId` are null at the ends.
 */
export function flowPosition(definition: FlowDefinition | null | undefined, stepId: string | undefined) {
    const order = flowOrder(definition);
    const i = order.indexOf(stepId);
    if (i < 0) return { index: 0, total: order.length, prevId: null, nextId: null };
    return {
        index: i + 1,
        total: order.length,
        prevId: i > 0 ? order[i - 1] : null,
        nextId: i < order.length - 1 ? order[i + 1] : null,
    };
}

/**
 * The number each step wears on the canvas ("AI STEP · 7"): 1, 2, 3… in run
 * order, notes skipped. Inline (expanded flowlet) children count inside their
 * parent — `3·1`, `3·2` — when the caller hands over the inline-id helpers
 * from flow/inlineFlowlets.js; this module stays import-free.
 */
export function stepNumbers(definition: DefinitionLike | null | undefined, { isInlineId = null, parseInlineId = null }: { isInlineId?: ((id: string) => boolean) | null; parseInlineId?: ((id: string) => { prefix: string }) | null } = {}) {
    const typeOf = new Map();
    for (const tr of [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])]) if (tr?.id) typeOf.set(tr.id, 'trigger');
    for (const st of Array.isArray(definition?.steps) ? definition.steps : []) if (st?.id) typeOf.set(st.id, st.type);
    const out = new Map();
    const inner = new Map(); // parent prefix → counter
    let n = 0;
    for (const id of flowOrder(definition)) {
        const type = typeOf.get(id);
        if (type === 'note') continue;
        if (!isInlineId || !parseInlineId || !isInlineId(id)) { n += 1; out.set(id, n); continue; }
        if (type === 'trigger' || type === 'loop_item') continue;
        const { prefix } = parseInlineId(id);
        const k = (inner.get(prefix) || 0) + 1;
        inner.set(prefix, k);
        const parent = out.get(prefix);
        out.set(id, parent != null ? `${parent}·${k}` : k);
    }
    return out;
}
