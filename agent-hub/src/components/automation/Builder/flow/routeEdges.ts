/**
 * Keep a Condition node's canvas wiring alive when the node changes
 * shape.
 *
 * Adding a second rule to an If turns it into a Switch; removing it turns it
 * back; ticking "work through a list" turns it into a Filter. Each of those
 * renames the node's output ports (`then`/`else` ↔ `case:<rule>`/`case:default`
 * ↔ one unlabelled port), and an edge whose label no longer names a real port
 * is dead — `switch.case_edge_unknown` is a BLOCKING validation error, so a
 * shape change that didn't heal its edges would lock every later save of the
 * whole automation (the same failure mode as the case-rename bug, C1).
 *
 * The fix is to re-point edges by SLOT (rule index, or the catch-all) rather
 * than by label: slots survive the shape change even though labels don't.
 * Edges whose slot no longer exists are dropped — heal, don't block, the same
 * philosophy as applyDeleteNodes and reconcileSwitchEdges.
 *
 * Pure; inputs are never mutated.
 */

import { copyExtraEdgeKeys, edgeKey } from './branchEdges';
import { routePorts, slotForEdge } from './routeModel';
import type { FlowDefinition, FlowEdge, FlowStep } from './types';

interface RoutePort { slot: number | string; label: string | null; caseName?: string }

/**
 * Re-point `stepId`'s outgoing edges from `prevStep`'s ports onto
 * `nextStep`'s.
 *
 * `definition` is the whole (scoped) graph, with the step ALREADY swapped in.
 * Returns the next definition (the same object when nothing had to change).
 */
export function reconcileRouteEdges(definition: FlowDefinition, stepId: string, prevStep: FlowStep, nextStep: FlowStep): FlowDefinition {
    if (!definition || !stepId || !prevStep || !nextStep) return definition;
    if (prevStep.type === nextStep.type && !shapeChanged(prevStep, nextStep)) return definition;

    const nextBySlot = new Map(routePorts(nextStep).map((p: RoutePort) => [String(p.slot), p]));
    const seen = new Set();
    const edges: FlowEdge[] = [];
    let touched = false;

    for (const e of (definition.edges || [])) {
        if (e.from !== stepId) { edges.push(e); continue; }
        // `on_error` is a retry port, not a branch — a condition/switch may not
        // carry one at all (the validator forbids it), so it survives a flip to
        // filter and is dropped on a flip away from it.
        if (e.label === 'on_error') {
            if (nextStep.type === 'filter') edges.push(e);
            else touched = true;
            continue;
        }
        const slot = slotForEdge(prevStep, e);
        if (slot === null) { edges.push(e); continue; } // not ours to re-point
        const port = nextBySlot.get(String(slot));
        if (!port) { touched = true; continue; }         // that output no longer exists
        const out: FlowEdge = { from: e.from, to: e.to };
        if (port.label) out.label = port.label;
        if (port.caseName != null) out.caseName = port.caseName;
        copyExtraEdgeKeys(e, out);
        if (edgeKey(out) !== edgeKey(e)) touched = true;
        edges.push(out);
    }

    // Two rules pointing at the same next step collapse to one row after a
    // shape change that merges their ports.
    const deduped = edges.filter((e: FlowEdge) => {
        const key = edgeKey(e);
        if (seen.has(key)) { touched = true; return false; }
        seen.add(key);
        return true;
    });

    return touched ? { ...definition, edges: deduped } : definition;
}

/** Did the port LAYOUT change (rule count / rule names), not just a value? */
function shapeChanged(prevStep: FlowStep, nextStep: FlowStep): boolean {
    const a = routePorts(prevStep).map((p: RoutePort) => `${p.slot}:${p.label || ''}`).join('|');
    const b = routePorts(nextStep).map((p: RoutePort) => `${p.slot}:${p.label || ''}`).join('|');
    return a !== b;
}
