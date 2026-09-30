/**
 * Keep a Condition node's wiring alive when the node changes shape — a port
 * of the web builder's flow/routeEdges.js, pinned by route.lockstep.test.ts.
 *
 * A second rule turns an If into a Switch, "work through a list" turns it
 * into a Filter; each renames the output ports, and an edge naming a port
 * that no longer exists is a BLOCKING validation error. So edges are
 * re-pointed by SLOT (rule index, or the catch-all), which survives the
 * change; an edge whose slot is gone is dropped. Pure.
 */

import { copyExtraEdgeKeys, edgeKey } from '../branchEdges';
import type { FlowDefinition, FlowEdge, FlowStep } from '../types';
import { routePorts, slotForEdge, type RoutePort } from './routeModel';

type RouteStep = Partial<Pick<FlowStep, 'type'>> & Record<string, unknown>;

/** Did the port LAYOUT change (rule count / names), not just a value? */
function shapeChanged(prevStep: RouteStep, nextStep: RouteStep): boolean {
    const sig = (s: RouteStep) => routePorts(s).map((p) => `${p.slot}:${p.label || ''}`).join('|');
    return sig(prevStep) !== sig(nextStep);
}

/** The edge re-pointed onto `port`, extra keys kept. */
function repoint(e: FlowEdge, port: RoutePort): FlowEdge {
    const out: FlowEdge = { from: e.from, to: e.to };
    if (port.label) out.label = port.label;
    if (port.caseName != null) out.caseName = port.caseName;
    return copyExtraEdgeKeys(e, out);
}

/**
 * Re-point `stepId`'s outgoing edges from `prevStep`'s ports onto
 * `nextStep`'s. `definition` already carries the swapped-in step. Returns the
 * same object when nothing had to change.
 */
export function reconcileRouteEdges<T extends Partial<Pick<FlowDefinition, 'edges'>> | null | undefined>(
    definition: T,
    stepId: string,
    prevStep: RouteStep | null | undefined,
    nextStep: RouteStep | null | undefined,
): T {
    if (!definition || !stepId || !prevStep || !nextStep) return definition;
    if (prevStep.type === nextStep.type && !shapeChanged(prevStep, nextStep)) return definition;

    const nextBySlot = new Map(routePorts(nextStep).map((p) => [String(p.slot), p]));
    /** The edge as it continues after the change: itself, re-pointed, or null (gone). */
    const carry = (e: FlowEdge): FlowEdge | null => {
        if (e.from !== stepId) return e;
        // `on_error` is a retry port, not a branch: kept on a filter, dropped on a brancher.
        if (e.label === 'on_error') return nextStep.type === 'filter' ? e : null;
        const slot = slotForEdge(prevStep, e);
        if (slot === null) return e;
        const port = nextBySlot.get(String(slot));
        return port ? repoint(e, port) : null;
    };
    const edges: FlowEdge[] = [];
    let touched = false;
    for (const e of definition.edges || []) {
        const out = carry(e);
        if (!out || edgeKey(out) !== edgeKey(e)) touched = true;
        if (out) edges.push(out);
    }

    const seen = new Set<string>();
    const deduped = edges.filter((e) => {
        const key = edgeKey(e);
        if (seen.has(key)) {
            touched = true;
            return false;
        }
        seen.add(key);
        return true;
    });
    return touched ? { ...definition, edges: deduped } : definition;
}
