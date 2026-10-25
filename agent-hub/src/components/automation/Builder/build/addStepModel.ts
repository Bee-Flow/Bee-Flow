// The pure half of BuildTab's insert path (build/useAddStep.ts): where a new
// step lands, how it is spliced into a connection, and the messages it raises.
// Split out of BuildTab without a change in behaviour.
import { applyAddNode as applyAddNodeJs } from '../applyAddNode';
import { COL_PITCH } from '../flow/buildChoreography';
import { branchFromHandle, spliceStepIntoEdge } from '../flow/branchEdges';
import { placeNewStep as placeNewStepTs } from '../flow/placeStep';
import { isRouteStep, routePorts } from '../flow/routeModel';
import type { FlowDefinition, FlowStep } from '../flow/types';

export interface Position { x: number; y: number }

// applyAddNode is JavaScript whose `= null` defaults read as the parameters' whole type.
const applyAddNode = applyAddNodeJs as (
    def: FlowDefinition, payload: Record<string, unknown>, position: Position,
    sourceId?: string | null, sourceHandle?: string | null,
) => FlowDefinition;

/** What an add-a-step surface hands the insert path. */
export interface AddStepPayload {
    kind: string;
    triggerKind?: string;
    asSecondaryTrigger?: boolean;
    /** Set on the second pass, after the user confirmed replacing the trigger. */
    __confirmedReplace?: boolean;
    title?: string;
    [key: string]: unknown;
}

/**
 * Where the step goes.
 *   - sourceId alone            → wire source→new (append after)
 *   - sourceId + targetId       → splice new INTO that connection
 *   - label/caseName            → which branch of the source it rides on
 */
export interface AddStepOptions {
    position?: Position | null;
    sourceId?: string | null;
    targetId?: string | null;
    sourceHandle?: string | null;
    label?: string | null;
    caseName?: string | null;
    /** The expanded flowlet the canvas says the step was dropped inside. */
    scopePrefix?: string;
}

/**
 * Kinds that cannot live inside a loop's body, and what to tell the user.
 *
 * Each mirrors a rule the server already enforces (automation/validate.js): a
 * form page has no resumable address inside an iteration, a body has no trigger
 * of its own, and Return belongs to a flowlet. Refusing at the gesture beats
 * accepting the step and surfacing a red banner two edits later.
 */
export const LOOP_BODY_REFUSALS: Record<string, string> = {
    trigger: 'An automation starts in one place. The loop already runs once per item — you can\'t start a new flow inside it.',
    form_page: 'Form steps can\'t run inside a loop: one page, one visitor, one answer. Put the form before or after the loop.',
    approval: 'Approvals can\'t run inside a loop: the run would pause on every item and could never be approved. Move the approval to the main flow, before or after the loop — approve once, then let every item through.',
    layer_output: 'Return hands data back from a flowlet. A loop keeps its results for the steps after it instead.',
    // Ends the WHOLE run. A loop is not its end: the step would run again per
    // item, leave no run row (the body runs with recordSteps:false) and so
    // return nothing to the app, while the automation carries on after the
    // loop. The validator refuses it here too —
    // server/automation/validate/constants.js NESTED_FORBIDDEN_RULES.
    return_to_app: 'Back to the app ends the whole automation, so it cannot sit inside a loop — the loop would just run it again for the next item. Put it after the loop, as the last step.',
};

/** Toast copy after an auto-map, noting when the step now iterates per item. */
export function autoMapToastMessage(count: number, forEachEnabled: boolean): string {
    const base = count
        ? `Auto-mapped ${count} input${count === 1 ? '' : 's'}`
        : 'Set up iteration';
    return forEachEnabled ? `${base} · runs once per item` : base;
}

function nodesOf(def: FlowDefinition): Array<FlowStep | null | undefined> {
    return [def.trigger, ...(def.steps || [])];
}

/** The node `id` in the graph (trigger or step), if any. */
export function findNode(def: FlowDefinition, id: string | null): FlowStep | null {
    if (!id) return null;
    return nodesOf(def).find(n => n?.id === id) || null;
}

function positionOf(node: FlowStep | null | undefined): Position | null {
    const p = node?.position as Position | undefined;
    return p && typeof p === 'object' ? p : null;
}

/**
 * Edge-aware positioning when the gesture carried no drop point. Three
 * fallbacks in order:
 *   1. If we're wiring from a specific source node (n8n "+ next step" button
 *      or edge-drop), drop just to the right of THAT node so the new step
 *      lines up with its origin, not whichever node happens to be rightmost.
 *   2. Otherwise (FAB / auto-open / search), drop to the right of the
 *      rightmost existing node so we don't stack on top of anything.
 *   3. Triggers and bare-canvas additions fall through to the canvas centre.
 */
export function defaultAddPosition(
    baseDef: FlowDefinition,
    sourceId: string | null,
    kind: string,
    canvasCenter: () => Position | null | undefined,
): Position {
    const src = positionOf(findNode(baseDef, sourceId));
    if (sourceId && src) return { x: src.x + COL_PITCH, y: src.y };
    if (kind !== 'trigger') {
        const rightmost = nodesOf(baseDef).filter(Boolean).reduce<FlowStep | null>((acc, n) => {
            const x = positionOf(n)?.x;
            if (typeof x !== 'number') return acc;
            return (!acc || x > (positionOf(acc)?.x ?? -Infinity)) ? (n as FlowStep) : acc;
        }, null);
        const at = positionOf(rightmost);
        if (at) return { x: at.x + COL_PITCH, y: at.y };
    }
    return canvasCenter() || { x: 0, y: 0 };
}

/** The step applyAddNode appended last: the one just added. */
export function lastStepId(def: FlowDefinition): string | null {
    const steps = def.steps || [];
    return steps.length ? steps[steps.length - 1].id : null;
}

/**
 * Edge-insert: when we were asked to splice between two nodes, rewire the
 * freshly added step to sit on the original edge — identity-matched, so ONLY
 * the clicked edge is replaced and parallel branch edges between the same pair
 * survive (B3). The branch label rides on source→new (the routing decision
 * point); new→target leaves by the inserted step's FIRST output — for a
 * Filter that is `then`, and an unlabelled edge there would never fire.
 */
function spliceInsertedIntoEdge(
    next: FlowDefinition,
    { sourceId, targetId, sourceHandle, label, caseName }: {
        sourceId: string; targetId: string; sourceHandle: string | null;
        label?: string | null; caseName?: string | null;
    },
): FlowDefinition {
    const steps = next.steps || [];
    const inserted = steps[steps.length - 1];
    const insertedId = inserted.id;
    const identity = (label != null || caseName != null)
        ? { label, caseName }
        : branchFromHandle(sourceHandle || null);
    // applyAddNode already appended source→new (stamped from the handle) —
    // drop it and let spliceStepIntoEdge emit the canonical trio, which also
    // covers labels the handle can't express (e.g. on_error).
    const withoutAuto = (next.edges || []).filter(e => !(e.from === sourceId && e.to === insertedId));
    const firstPort = isRouteStep(inserted) ? routePorts(inserted)[0] : null;
    return { ...next, edges: spliceStepIntoEdge(withoutAuto, insertedId, sourceId, targetId, identity, firstPort) };
}

/** Where a step is wired, once the payload's kind has had its say. */
export interface Wiring {
    sourceId: string | null;
    targetId: string | null;
    sourceHandle: string | null;
    /** The expanded flowlet the step goes into ('' for the canvas's own graph). */
    scopePrefix: string;
}

/**
 * A trigger is never wired FROM something — applyAddNode replaces (or appends
 * to) the graph's entry points and adds no edge, so honouring a drop target
 * would splice/auto-map whatever step happened to be last. A note (BFSF-411)
 * is a canvas annotation that is never wired at all: the runner and the
 * validator both refuse edges on it.
 *
 * Which graph the step goes into: the canvas says so when it was dropped
 * inside an expanded flowlet; otherwise the thing it is wired to decides,
 * since a connection never crosses a flowlet boundary. Triggers always belong
 * to the canvas's own graph.
 */
export function wiringFor(
    payload: AddStepPayload, opts: AddStepOptions, prefixOf: (id: string) => string,
): Wiring {
    const wirable = payload.kind !== 'trigger' && payload.kind !== 'note';
    const sourceId = (wirable && opts.sourceId) || null;
    const targetId = (wirable && opts.targetId) || null;
    const sourceHandle = (wirable && opts.sourceHandle) || null;
    const scopePrefix = wirable ? (opts.scopePrefix ?? prefixOf(sourceId || targetId || '')) : '';
    return { sourceId, targetId, sourceHandle, scopePrefix };
}

// placeStep's own Def has no null trigger; a normalised definition never carries one there.
const placeNewStep = placeNewStepTs as (
    def: FlowDefinition, insertedId: string, opts: { sourceId?: string | null; targetId?: string | null; keepIfFree?: boolean },
) => FlowDefinition;

/**
 * Add the step, splice it into the connection it was dropped on, and give it
 * a free column. Positions are stored, so nothing re-lays-out after this: the
 * new card gets a free column next to its source (a splice slides the
 * downstream cards right). A drop point the author chose is kept when it is
 * clear of every card. Inside an expanded flowlet positions live in that
 * flowlet's own space, so they are left alone.
 */
export function addAndPlace(
    baseDef: FlowDefinition, payload: AddStepPayload, position: Position, w: Wiring,
    opts: AddStepOptions,
): { next: FlowDefinition; addedId: string | null } {
    const { sourceId, targetId, sourceHandle, scopePrefix } = w;
    let next = addNode(baseDef, payload, position, sourceId, sourceHandle);
    if (sourceId && targetId && next.steps?.length) {
        next = spliceInsertedIntoEdge(next, { sourceId, targetId, sourceHandle, label: opts.label, caseName: opts.caseName });
    }
    const before = new Set((baseDef.steps || []).map(s => s.id));
    const addedId = (next.steps || []).find(s => !before.has(s.id))?.id || null;
    if (!scopePrefix && sourceId && addedId) {
        next = placeNewStep(next, addedId, { sourceId, targetId, keepIfFree: !!opts.position && !targetId });
    }
    return { next, addedId };
}

/** applyAddNode with the definition types this folder speaks. */
export function addNode(
    def: FlowDefinition,
    payload: Record<string, unknown>,
    position: Position,
    sourceId: string | null,
    sourceHandle: string | null,
): FlowDefinition {
    return applyAddNode(def, payload, position, sourceId, sourceHandle);
}
