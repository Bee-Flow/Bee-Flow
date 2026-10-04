/**
 * A node's outgoing edges, sorted into what the outline draws: the plain
 * continuation, the named branches (lanes), and the error path.
 *
 * The branch names are the canvas's port labels — ConditionNode's
 * "match"/"otherwise", SwitchNode's case names and "otherwise", GuardNode's
 * "personal data"/"clean", LoopNode's "On error" — so a lane on the phone is
 * called what the port it hangs off is called in the browser.
 */

import { PORT, routePorts, type AnyNode, type EdgeIdentity, type FlowEdge } from '..';
import type { LaneTone, RowText } from './types';

export interface Lane {
    /** The port the lane leaves by: what `branchFromHandle` wires a new step from. */
    handle: string | null;
    identity: EdgeIdentity;
    text: RowText;
    tone: LaneTone;
    edges: FlowEdge[];
}

export interface Outgoing {
    /** Unlabelled (or `on_success`) edges: what runs next. */
    main: FlowEdge[];
    /** Named branches, in port order, empty ones included. */
    lanes: Lane[];
    /** The `on_error` path, when there is one. */
    error: FlowEdge[];
}

const text = (key: string, fallback: string): RowText => ({ key: `mobile.flow.lane.${key}`, fallback });

interface PortSpec {
    handle: string;
    identity: EdgeIdentity;
    text: RowText;
    tone: LaneTone;
}

const CONDITION_PORTS: readonly PortSpec[] = [
    { handle: PORT.then, identity: { label: PORT.then }, text: text('match', 'match'), tone: 'then' },
    { handle: PORT.else, identity: { label: PORT.else }, text: text('otherwise', 'otherwise'), tone: 'else' },
];

const GUARD_PORTS: readonly PortSpec[] = [
    { handle: PORT.then, identity: { label: PORT.then }, text: text('personal_data', 'personal data'), tone: 'else' },
    { handle: PORT.else, identity: { label: PORT.else }, text: text('clean', 'clean'), tone: 'then' },
];

function switchPorts(node: AnyNode): PortSpec[] {
    return routePorts(node as Parameters<typeof routePorts>[0]).map((p) =>
        p.caseName === PORT.defaultCase
            ? { handle: PORT.defaultCaseLabel, identity: { label: p.label, caseName: p.caseName }, text: text('otherwise', 'otherwise'), tone: 'default' as const }
            : { handle: p.label as string, identity: { label: p.label, caseName: p.caseName }, text: { raw: p.caseName ?? '' }, tone: 'case' as const },
    );
}

/** The named ports a node routes on; none for a node with one way out. */
export function branchPorts(node: AnyNode | null | undefined): PortSpec[] {
    if (!node) return [];
    if (node.type === 'condition') return [...CONDITION_PORTS];
    if (node.type === 'guard') return [...GUARD_PORTS];
    if (node.type === 'switch') return switchPorts(node);
    return [];
}

/** A plain continuation: no branch label (a `caseName` alone still names a switch branch). */
const isMain = (e: FlowEdge) => (!e.label && e.caseName == null) || e.label === 'on_success';
const caseOf = (e: FlowEdge) => e.caseName ?? (typeof e.label === 'string' && e.label.startsWith('case:') ? e.label.slice(5) : null);

function matchesPort(e: FlowEdge, port: PortSpec): boolean {
    const want = port.identity;
    if (want.caseName != null) return caseOf(e) === want.caseName;
    return (e.label || null) === (want.label || null);
}

/** A label no declared port claims (an old case, a hand-written edge): its own lane. */
function strayLane(label: string, edges: FlowEdge[]): Lane {
    const caseName = caseOf(edges[0] as FlowEdge);
    return {
        handle: label,
        identity: caseName != null ? { label, caseName } : { label },
        text: { raw: caseName ?? label },
        tone: caseName != null ? 'case' : 'then',
        edges,
    };
}

/** Sort a node's outgoing edges into continuation, lanes and error path. */
export function outgoingOf(node: AnyNode | null | undefined, edges: readonly FlowEdge[]): Outgoing {
    const main = edges.filter(isMain);
    const error = edges.filter((e) => e.label === PORT.onError);
    const labelled = edges.filter((e) => !isMain(e) && e.label !== PORT.onError);
    const ports = branchPorts(node);
    const lanes: Lane[] = ports.map((p) => ({ ...p, edges: labelled.filter((e) => matchesPort(e, p)) }));
    const claimed = new Set(lanes.flatMap((l) => l.edges));
    const stray = new Map<string, FlowEdge[]>();
    for (const e of labelled) {
        if (claimed.has(e)) continue;
        const key = String(e.label);
        stray.set(key, [...(stray.get(key) ?? []), e]);
    }
    for (const [label, list] of stray) lanes.push(strayLane(label, list));
    return { main, lanes, error };
}

/** An edge's branch identity, for a splice that must replace exactly it. */
export function identityOf(e: FlowEdge): EdgeIdentity {
    const out: EdgeIdentity = {};
    if (e.label) out.label = e.label;
    if (e.caseName != null) out.caseName = e.caseName;
    return out;
}

/** The error path as a lane — the loop port's own words, `automations.canvas.loop_port_on_error`. */
export function errorLane(edges: FlowEdge[]): Lane {
    return {
        handle: PORT.onError,
        identity: { label: PORT.onError },
        text: { key: 'automations.canvas.loop_port_on_error', fallback: 'On error' },
        tone: 'error',
        edges,
    };
}

/** Several plain edges out of one step: each is a path of its own, run side by side. */
export function pathLanes(edges: FlowEdge[]): Lane[] {
    return edges.map((e, i) => ({
        handle: null,
        identity: identityOf(e),
        text: { key: 'mobile.flow.lane.path', fallback: 'Path {n}', params: { n: i + 1 } },
        tone: 'path' as const,
        edges: [e],
    }));
}
