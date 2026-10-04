/**
 * Putting a picked step where the "+" said — the phone's half of the web's
 * one insert path (BuildTab.jsx `addStepAt`): the same graph operations in the
 * same order, so a step added on the phone is wired exactly as one added in
 * the browser.
 *
 *   after   applyAddNode wired from the source's port (auto-map follows:
 *           bindings/autoMapInsert.ts, since mapping reads the bindings);
 *   splice  applyAddNode unwired, then spliceStepIntoEdge — only the edge the
 *           "+" sat on is replaced, and the new step leaves by its FIRST port
 *           when it is a route (a Filter's continuation is `then`);
 *   inline  a held step, inserted into a loop body or a parallel branch;
 *   root    a trigger (it replaces the primary, or joins the secondaries) or
 *           a note — neither is ever wired.
 */

import {
    addedNodeId, applyAddNode, buildStepFromPayload, isRouteStep, routePorts, seedPositions, spliceStepIntoEdge, uniqueStepId,
    type AnyNode, type FlowDefinition, type FlowStep, type Position, type StepPayload,
} from '..';
import { allIds, childAddress, inlineList, updateAtAddress, withInlineList } from './nested';
import type { AddTarget } from './types';

export interface InsertResult {
    definition: FlowDefinition;
    /** The new node's id, or null when nothing was added. */
    addedId: string | null;
    /** Its address (the container path for a held step). */
    address: string | null;
    /** Wired from a source (after a step, or onto an edge): its inputs may be auto-mapped. */
    wired: boolean;
}

/** The web's spacing between a step and the one added after it (BuildTab.jsx). */
const NEXT_X = 280;

function nodeById(def: FlowDefinition, id: string): AnyNode | undefined {
    return [def.trigger, ...(def.triggers || []), ...def.steps].find((n): n is AnyNode => !!n && n.id === id);
}

/** Where the canvas puts it: right of the source, between the two ends of a spliced edge, or right of everything. */
export function positionFor(def: FlowDefinition, target: AddTarget): Position | null {
    const src = target.kind === 'after' || target.kind === 'splice' ? nodeById(def, target.sourceId)?.position : null;
    const dst = target.kind === 'splice' ? nodeById(def, target.targetId)?.position : null;
    if (src && dst) return { x: Math.round((src.x + dst.x) / 2), y: Math.round((src.y + dst.y) / 2) + 60 };
    if (src) return { x: src.x + NEXT_X, y: src.y };
    const placed = [def.trigger, ...def.steps].filter((n) => n?.position && Number.isFinite(n.position.x));
    const rightmost = placed.reduce<Position | null>((acc, n) => (!acc || (n?.position?.x ?? 0) > acc.x ? (n?.position as Position) : acc), null);
    return rightmost ? { x: rightmost.x + NEXT_X, y: rightmost.y } : null;
}

const none = (definition: FlowDefinition): InsertResult => ({ definition, addedId: null, address: null, wired: false });

function insertInline(def: FlowDefinition, target: Extract<AddTarget, { kind: 'inline' }>, payload: StepPayload): InsertResult {
    const built = buildStepFromPayload(payload, null);
    if (!built || built.type === 'trigger') return none(def);
    const taken = allIds(def);
    // A held step has no canvas position of its own: the loop draws its body.
    const step: FlowStep = { ...(built as FlowStep) };
    delete step.position;
    if (taken.has(step.id)) step.id = uniqueStepId(step.type, taken);
    const next = updateAtAddress(def, target.container, (container) => {
        const list = inlineList(container, target.branch).slice();
        list.splice(Math.max(0, Math.min(target.index, list.length)), 0, step);
        return withInlineList(container, target.branch, list);
    });
    if (next === def) return none(def);
    return { definition: next, addedId: step.id, address: childAddress(target.container, step.id), wired: false };
}

function spliceInto(next: FlowDefinition, target: Extract<AddTarget, { kind: 'splice' }>, insertedId: string): FlowDefinition {
    const inserted = next.steps.find((s) => s.id === insertedId);
    const first = inserted && isRouteStep(inserted) ? routePorts(inserted)[0] : null;
    const edges = spliceStepIntoEdge(next.edges, {
        insertedId,
        sourceId: target.sourceId,
        targetId: target.targetId,
        identity: target.identity,
        insertedPort: first ? { label: first.label, caseName: first.caseName ?? null } : null,
    });
    return { ...next, edges };
}

/**
 * The definition with `payload` added at `target`. A trigger or a note
 * ignores the target (neither is wired); a step with nowhere to go comes back
 * as "nothing added".
 */
export function insertStep(def: FlowDefinition, target: AddTarget, payload: StepPayload): InsertResult {
    const unwired = payload.kind === 'trigger' || payload.kind === 'note' || target.kind === 'root';
    if (!unwired && target.kind === 'inline') return insertInline(def, target, payload);
    // An automation nobody has placed yet is drawn by the fallback layout: keep
    // that layout (write it down) before adding, so the new step goes next to
    // its source as drawn — not to (0,0), on top of the trigger, with the
    // rest of the flow re-laid out around it.
    const placed = seedPositions(def) as FlowDefinition;
    const position = unwired ? positionFor(placed, { kind: 'root' }) : positionFor(placed, target);
    const wireFrom = !unwired && target.kind === 'after' ? { sourceId: target.sourceId, sourceHandle: target.handle } : {};
    let next = applyAddNode(placed, payload, { position, ...wireFrom }) as FlowDefinition;
    if (next === placed) return none(def);
    const addedId = addedNodeId(placed, next);
    if (!addedId) return none(def);
    if (!unwired && target.kind === 'splice') next = spliceInto(next, target, addedId);
    return { definition: next, addedId, address: addedId, wired: !unwired };
}
