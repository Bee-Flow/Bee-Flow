/**
 * The canvas's lines and "+" spots, from the placed nodes.
 *
 * A line knows what its "+" does: on a connection it splices a step into
 * exactly that edge (its branch identity kept, the web's onEdgeInsertClick);
 * inside an open loop it inserts into the body before the step the line runs
 * to (a body has no edges of its own — its order IS its wiring). A body line
 * is derived, so it cannot be removed; only a real connection can.
 *
 * A "+" spot sits beside a port nothing leaves from — the web card's "+ next
 * step" — and at the end of every open loop's body.
 */

import { isTerminalStep, type EdgeIdentity, type FlowEdge } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';

import { classifyEdges, type ClassifiedEdge } from './edgeModel';
import { chipOffset, edgeGeometry, laneOffset, type EdgeGeometry } from './edgePath';
import { parseInlineId, type ComposedLoops } from './inlineLoops';
import { portFor } from './ports';
import type { SceneNode } from './scene';
import type { Point } from './viewport';

export interface SceneEdge extends ClassifiedEdge {
    /** The open loop whose body this line chains; null for a real connection. */
    container: string | null;
    /** The port it leaves by (a PortSpec id). */
    sourcePort: string | null;
    geometry: EdgeGeometry;
    /** The two ports it joins (for the rubber band a drag draws). */
    ends: { sx: number; sy: number; tx: number; ty: number };
    /** Where its chip and "+" sit. */
    chipAt: Point;
    insert: AddTarget;
    removable: boolean;
}

export interface AddSpot {
    key: string;
    /** The node the "+" hangs off. */
    owner: string;
    x: number;
    y: number;
    target: AddTarget;
}

/** How far right of its port a "+" sits. */
export const ADD_GAP = 22;

interface Input {
    nodes: readonly SceneNode[];
    byKey: ReadonlyMap<string, SceneNode>;
    defEdges: readonly FlowEdge[];
    composed: ComposedLoops;
}

function identityOf(e: ClassifiedEdge): EdgeIdentity {
    const out: EdgeIdentity = {};
    if (e.defLabel) out.label = e.defLabel;
    if (e.defCaseName != null) out.caseName = e.defCaseName;
    return out;
}

function insertFor(e: ClassifiedEdge, container: string | null, composed: ComposedLoops): AddTarget {
    if (!container) return { kind: 'splice', sourceId: e.from, targetId: e.to, identity: identityOf(e) };
    const childIds = composed.containers.get(container)?.childIds ?? [];
    return { kind: 'inline', container, branch: null, index: Math.max(0, childIds.indexOf(e.to) - 1) };
}

function toSceneEdge(e: ClassifiedEdge, from: SceneNode, to: SceneNode, composed: ComposedLoops): SceneEdge {
    const port = portFor(from.ports, e.sourceHandle);
    const sx = from.x + from.width;
    const sy = from.y + (port ? port.dy : from.height / 2);
    const tx = to.x;
    const ty = to.y + (to.targetDy ?? to.height / 2) + laneOffset(e.parallelIndex, e.parallelCount);
    const geometry = edgeGeometry(sx, sy, tx, ty);
    const container = parseInlineId(e.from).prefix === parseInlineId(e.to).prefix ? parseInlineId(e.to).prefix || null : null;
    return {
        ...e,
        container,
        sourcePort: port?.id ?? null,
        geometry,
        ends: { sx, sy, tx, ty },
        chipAt: { x: geometry.label.x + chipOffset(e.parallelIndex, e.parallelCount), y: geometry.label.y },
        insert: insertFor(e, container, composed),
        removable: container === null,
    };
}

function danglingSpots(nodes: readonly SceneNode[], edges: readonly SceneEdge[]): AddSpot[] {
    const used = new Set(edges.map((e) => `${e.from}|${e.sourcePort}`));
    const out: AddSpot[] = [];
    for (const n of nodes) {
        if (n.parent !== null || n.kind === 'note') continue;
        for (const p of n.ports) {
            if (p.id === 'on_error' || used.has(`${n.key}|${p.id}`)) continue;
            out.push({
                key: `add:${n.key}|${p.id}`, owner: n.key, x: n.x + n.width + ADD_GAP, y: n.y + p.dy,
                target: { kind: 'after', sourceId: n.nodeId, handle: p.wire },
            });
        }
    }
    return out;
}

function bodyEndSpots(byKey: ReadonlyMap<string, SceneNode>, composed: ComposedLoops): AddSpot[] {
    const out: AddSpot[] = [];
    for (const c of composed.containers.values()) {
        const last = byKey.get(c.childIds[c.childIds.length - 1] as string);
        const port = last?.ports[0];
        if (!last || !port || isTerminalStep(last.node)) continue;
        out.push({
            key: `add:${c.prefix}|end`, owner: last.key, x: last.x + last.width + ADD_GAP, y: last.y + port.dy,
            target: { kind: 'inline', container: c.prefix, branch: null, index: c.childIds.length - 1 },
        });
    }
    return out;
}

export function sceneEdges({ nodes, byKey, defEdges, composed }: Input): { edges: SceneEdge[]; adds: AddSpot[] } {
    const info = nodes.map((n) => ({ id: n.key, type: n.node.type, cases: n.node.cases }));
    const classified = classifyEdges(info, [...defEdges, ...composed.edges]);
    const edges: SceneEdge[] = [];
    for (const e of classified) {
        const from = byKey.get(e.from);
        const to = byKey.get(e.to);
        if (from && to) edges.push(toSceneEdge(e, from, to, composed));
    }
    return { edges, adds: [...danglingSpots(nodes, edges), ...bodyEndSpots(byKey, composed)] };
}
