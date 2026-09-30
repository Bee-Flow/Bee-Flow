/**
 * The Steps outline: a routine's graph as one vertical list, the phone's
 * reading of the web canvas (flow/layout.js lays the same graph out left to
 * right).
 *
 *   - Triggers first: the primary, then any secondary ones.
 *   - Then the flow in run order, one card per step. A step with one way out
 *     is followed by the next; a Condition, a Switch or a guard opens one
 *     indented LANE per port, and the lanes close where they meet again (the
 *     first step every lane reaches), which then continues at the outer depth.
 *   - A loop's body and each parallel branch are collapsible GROUPS under
 *     their step: those steps are held, not wired.
 *   - A "+" between every two cards and at the end of every lane.
 *   - A step the walk reaches a second time (a join from elsewhere, a way
 *     back) is shown once, and a JUMP row points at it.
 *   - Whatever no trigger reaches is listed last, under "Not connected".
 *
 * Pure: rows in, nothing rendered. Every row key is unique.
 */

import { flowOrder, isTerminalStep, type AnyNode, type FlowDefinition, type FlowEdge, type FlowStep } from '..';
import { branchesOf, childAddress, inlineList } from './nested';
import { errorLane, identityOf, outgoingOf, pathLanes, type Lane } from './ports';
import { triggerName } from './triggerSummary';
import type { AddTarget, OutlineOptions, OutlineRow, RowText } from './types';

type Stops = ReadonlySet<string>;
const NO_STOPS: Stops = new Set();

interface Walk {
    nodes: Map<string, AnyNode>;
    out: Map<string, FlowEdge[]>;
    order: Map<string, number>;
    placed: Set<string>;
    rows: OutlineRow[];
    keys: Set<string>;
    collapsed: ReadonlySet<string>;
}

/** The key a loop body or a parallel branch folds under. */
export function groupKey(container: string, branch: number | null): string {
    return `group:${container}|${branch === null ? 'body' : branch}`;
}

function push(w: Walk, row: OutlineRow): void {
    let key = row.key;
    for (let n = 1; w.keys.has(key); n += 1) key = `${row.key}#${n}`;
    w.keys.add(key);
    w.rows.push({ ...row, key });
}

function pushAdd(w: Walk, depth: number, target: AddTarget, end: boolean): void {
    const where =
        target.kind === 'after' ? `${target.sourceId}>${target.handle ?? ''}`
        : target.kind === 'splice' ? `${target.sourceId}>${target.targetId}|${target.identity.label ?? ''}|${target.identity.caseName ?? ''}`
        : target.kind === 'inline' ? `${target.container}|${target.branch ?? 'body'}|${target.index}`
        : 'root';
    push(w, { kind: 'add', key: `add:${target.kind}:${where}`, depth, target, end });
}

function reach(w: Walk, starts: readonly string[], stops: Stops): Set<string> {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length) {
        const id = queue.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        if (stops.has(id)) continue;
        for (const e of w.out.get(id) ?? []) queue.push(e.to);
    }
    return seen;
}

/**
 * Where a set of lanes meets again: the earliest step (in run order) that at
 * least two lanes reach. A lane that ends on its own (a Stop, a Return) does
 * not keep the others from meeting.
 */
function findJoin(w: Walk, lanes: readonly Lane[], stops: Stops): string | null {
    const starts = lanes.map((l) => l.edges.map((e) => e.to)).filter((s) => s.length > 0);
    if (starts.length < 2) return null;
    const hits = new Map<string, number>();
    for (const s of starts) for (const id of reach(w, s, stops)) hits.set(id, (hits.get(id) ?? 0) + 1);
    const common = [...hits].filter(([id, n]) => n >= 2 && !w.placed.has(id)).map(([id]) => id);
    common.sort((a, b) => (w.order.get(a) ?? 0) - (w.order.get(b) ?? 0));
    return common[0] ?? null;
}

function pushJump(w: Walk, depth: number, fromId: string, toId: string): void {
    const back = reach(w, [toId], NO_STOPS).has(fromId);
    push(w, { kind: 'jump', key: `jump:${fromId}>${toId}`, depth, toId, back });
}

// ── Held steps ───────────────────────────────────────────────────────

function pushInlineGroup(w: Walk, step: FlowStep, spot: { container: string; branch: number | null; depth: number }, text: RowText): void {
    const { container, branch, depth } = spot;
    const list = inlineList(step, branch);
    const key = groupKey(container, branch);
    const collapsed = w.collapsed.has(key);
    push(w, { kind: 'group', key, depth, container, branch, count: list.length, collapsed, text });
    if (collapsed) return;
    list.forEach((item, index) => {
        pushAdd(w, depth, { kind: 'inline', container, branch, index }, false);
        const address = childAddress(container, item.id);
        push(w, { kind: 'step', key: `step:${address}`, depth, address, nodeId: item.id, nested: true });
        pushContainers(w, item, address, depth);
    });
    pushAdd(w, depth, { kind: 'inline', container, branch, index: list.length }, true);
}

function pushContainers(w: Walk, step: FlowStep, address: string, depth: number): void {
    if (step.type === 'loop') {
        pushInlineGroup(w, step, { container: address, branch: null, depth: depth + 1 }, {
            key: 'mobile.flow.group.each_item', fallback: 'For each item',
        });
    } else if (step.type === 'parallel') {
        branchesOf(step).forEach((_, b) => {
            pushInlineGroup(w, step, { container: address, branch: b, depth: depth + 1 }, {
                key: 'mobile.flow.group.branch', fallback: 'Branch {n}', params: { n: b + 1 },
            });
        });
    }
}

// ── The wired graph ──────────────────────────────────────────────────

function pushNode(w: Walk, id: string, depth: number): void {
    w.placed.add(id);
    push(w, { kind: 'step', key: `step:${id}`, depth, address: id, nodeId: id, nested: false });
    const node = w.nodes.get(id);
    if (node && node.type !== 'trigger') pushContainers(w, node as FlowStep, id, depth);
}

/** Where the walk is: the depth it draws at, and the steps that end a lane here (joins). */
interface At {
    depth: number;
    stops: Stops;
}

/** One edge out of a lane: the "+" on it, then whatever it leads to. */
function followEdge(w: Walk, sourceId: string, e: FlowEdge, at: At): void {
    const stop = at.stops.has(e.to);
    const seen = w.placed.has(e.to);
    pushAdd(w, at.depth, { kind: 'splice', sourceId, targetId: e.to, identity: identityOf(e) }, stop);
    if (stop) return;
    if (seen) pushJump(w, at.depth, sourceId, e.to);
    else chain(w, e.to, at);
}

function pushLanes(w: Walk, sourceId: string, lanes: readonly Lane[], at: At): void {
    for (const lane of lanes) {
        const tag = lane.handle ?? lane.edges[0]?.to ?? '';
        push(w, { kind: 'lane', key: `lane:${sourceId}|${tag}`, depth: at.depth, text: lane.text, tone: lane.tone });
        if (lane.edges.length === 0) {
            pushAdd(w, at.depth, { kind: 'after', sourceId, handle: lane.handle }, true);
            continue;
        }
        for (const e of lane.edges) followEdge(w, sourceId, e, at);
    }
}

/** The plain continuation: the "+" and the next step to draw at this depth, if any. */
function nextOnMain(w: Walk, id: string, edge: FlowEdge | null, at: At): string | null {
    if (!edge) {
        if (!isTerminalStep(w.nodes.get(id))) pushAdd(w, at.depth, { kind: 'after', sourceId: id, handle: null }, true);
        return null;
    }
    const stop = at.stops.has(edge.to);
    pushAdd(w, at.depth, { kind: 'splice', sourceId: id, targetId: edge.to, identity: identityOf(edge) }, stop);
    if (stop) return null;
    if (w.placed.has(edge.to)) {
        pushJump(w, at.depth, id, edge.to);
        return null;
    }
    return edge.to;
}

const withStop = (stops: Stops, id: string | null): Stops => (id ? new Set([...stops, id]) : stops);

/** Everything after a node's card; returns the step that carries on at the same depth. */
function continueFrom(w: Walk, id: string, at: At): string | null {
    const { main, lanes, error } = outgoingOf(w.nodes.get(id), w.out.get(id) ?? []);
    const inner = at.depth + 1;
    const branched = lanes.length > 0 || main.length > 1;
    if (!branched) {
        if (error.length) pushLanes(w, id, [errorLane(error)], { depth: inner, stops: withStop(at.stops, main[0]?.to ?? null) });
        return nextOnMain(w, id, main[0] ?? null, at);
    }
    const all = [...(lanes.length ? [...lanes, ...pathLanes(main)] : pathLanes(main)), ...(error.length ? [errorLane(error)] : [])];
    const join = findJoin(w, all, at.stops);
    pushLanes(w, id, all, { depth: inner, stops: withStop(at.stops, join) });
    return join && !w.placed.has(join) && !at.stops.has(join) ? join : null;
}

function chain(w: Walk, start: string, at: At): void {
    let cur: string | null = start;
    while (cur && !w.placed.has(cur)) {
        pushNode(w, cur, at.depth);
        cur = continueFrom(w, cur, at);
    }
}

const TOP: At = { depth: 0, stops: NO_STOPS };

// ── The whole outline ────────────────────────────────────────────────

function makeWalk(def: FlowDefinition, collapsed: ReadonlySet<string>): Walk {
    const triggers = [def.trigger, ...(def.triggers || [])].filter((t): t is NonNullable<typeof t> => !!t?.id);
    const nodes = new Map<string, AnyNode>();
    for (const n of [...triggers, ...def.steps]) if (n?.id && !nodes.has(n.id)) nodes.set(n.id, n);
    const out = new Map<string, FlowEdge[]>();
    for (const e of def.edges) {
        if (!e || !nodes.has(e.from) || !nodes.has(e.to)) continue;
        out.set(e.from, [...(out.get(e.from) ?? []), e]);
    }
    const order = new Map(flowOrder(def).map((id, i) => [id, i]));
    return { nodes, out, order, placed: new Set(), rows: [], keys: new Set(), collapsed };
}

/** A secondary trigger whose steps the primary does not reach: its own section. */
function pushSecondaryFlows(w: Walk, def: FlowDefinition): void {
    for (const sec of def.triggers || []) {
        if (!sec?.id) continue;
        const outs = w.out.get(sec.id) ?? [];
        const fresh = outs.filter((e) => !w.placed.has(e.to));
        if (outs.length && !fresh.length) continue;
        push(w, {
            kind: 'section', key: `section:${sec.id}`,
            text: { key: 'mobile.flow.section.also_from', fallback: 'Also starts from {name}', params: { name: triggerName(sec) } },
        });
        if (!outs.length) pushAdd(w, 0, { kind: 'after', sourceId: sec.id, handle: null }, true);
        for (const e of fresh) followEdge(w, sec.id, e, TOP);
    }
}

function pushLoose(w: Walk): void {
    const loose = [...w.order.keys()].filter((id) => {
        const node = w.nodes.get(id);
        return !w.placed.has(id) && node && node.type !== 'trigger' && node.type !== 'note';
    });
    if (!loose.length) return;
    push(w, { kind: 'section', key: 'section:loose', text: { key: 'mobile.flow.section.loose', fallback: 'Not connected' } });
    for (const id of loose) chain(w, id, TOP);
}

/** The outline of a definition, top to bottom. */
export function buildOutlineRows(def: FlowDefinition | null | undefined, { collapsed = new Set() }: OutlineOptions = {}): OutlineRow[] {
    if (!def) return [];
    const w = makeWalk(def, collapsed);
    const primary = def.trigger?.id ? def.trigger : null;
    if (!primary) pushAdd(w, 0, { kind: 'root' }, true);
    for (const t of [primary, ...(def.triggers || [])]) {
        if (!t?.id || w.placed.has(t.id)) continue;
        w.placed.add(t.id);
        push(w, { kind: 'trigger', key: `trigger:${t.id}`, depth: 0, nodeId: t.id, primary: t === primary });
    }
    if (primary) {
        const next = continueFrom(w, primary.id, TOP);
        if (next) chain(w, next, TOP);
    }
    pushSecondaryFlows(w, def);
    pushLoose(w);
    return w.rows;
}
