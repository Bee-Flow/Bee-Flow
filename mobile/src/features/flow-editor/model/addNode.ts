/**
 * Adding a node — a port of the web builder's applyAddNode.js, pinned by
 * addNode.lockstep.test.ts.
 *
 * `buildStepFromPayload` turns a palette payload into a fully scaffolded step
 * or trigger; `applyAddNode` puts it in the definition (a trigger payload
 * replaces `trigger` or, as a secondary, appends to `triggers[]`), wires it
 * from a source port when one is given, and gives every unplaced node a
 * position. `createsCycle` guards a hand-drawn connection. All pure.
 */

import { seedPositions } from './arrange';
import { branchFromHandle } from './branchEdges';
import { defaultFormDeclaration } from './formDefaults';
import { newStepId } from './ids';
import { asDefinition } from './normalize';
import { scaffoldFor, type StepPayload } from './scaffolds';
import { defaultTriggerLabel } from './triggerLabels';
import type { DefinitionInput, FlowDefinition, FlowEdge, FlowStep, FlowTrigger, Position } from './types';

export type { StepPayload } from './scaffolds';

/** A built trigger carries which of the two trigger slots it goes into. */
export type BuiltTrigger = FlowTrigger & { __replaceTrigger?: true; __addTrigger?: true };

function buildTrigger(payload: StepPayload, position: Position | null | undefined): BuiltTrigger {
    const kind = payload.triggerKind || 'manual';
    return {
        [payload.asSecondaryTrigger ? '__addTrigger' : '__replaceTrigger']: true,
        id: newStepId('trigger'),
        type: 'trigger',
        kind,
        label: payload.label || defaultTriggerLabel(kind),
        output: {},
        ...(payload.triggerKind === 'form' ? { form: defaultFormDeclaration() } : null),
        position: position || { x: 0, y: 0 },
    };
}

/**
 * A palette payload → a scaffolded step or trigger, or null for nothing
 * placeable (no kind, or the `create_layer` meta-action).
 */
export function buildStepFromPayload(
    payload: StepPayload | null | undefined,
    position?: Position | null,
): FlowStep | BuiltTrigger | null {
    if (!payload || !payload.kind) return null;
    if (payload.kind === 'create_layer') return null;
    if (payload.kind === 'trigger') return buildTrigger(payload, position);
    return {
        id: newStepId(payload.kind),
        type: payload.kind,
        position: position || { x: 0, y: 0 },
        ...scaffoldFor(payload),
    };
}

export interface AddNodeOptions {
    position?: Position | null;
    /** Wire the new step from this node… */
    sourceId?: string | null;
    /** …out of this port (`then`, `else`, `case:<name>`, `on_error`, or none). */
    sourceHandle?: string | null;
}

function placeTrigger(base: FlowDefinition, built: BuiltTrigger, definition: DefinitionInput): FlowDefinition | DefinitionInput {
    const { __replaceTrigger, __addTrigger, ...trigger } = built;
    if (__replaceTrigger) {
        // Keep the existing trigger's id so saved edges still resolve.
        if (base.trigger?.id) trigger.id = base.trigger.id;
        return seedPositions({ ...base, trigger });
    }
    // triggers[] is root-only: a flowlet's graph cannot carry secondary triggers.
    if (!__addTrigger || base.trigger?.kind === 'layer_input') return definition;
    return seedPositions({ ...base, triggers: [...(base.triggers || []), trigger] });
}

/**
 * The definition with the payload's node added. A note is never wired, even
 * when dropped on a port.
 */
export function applyAddNode<T extends DefinitionInput>(
    definition: T,
    payload: StepPayload | null | undefined,
    { position = null, sourceId = null, sourceHandle = null }: AddNodeOptions = {},
): T | FlowDefinition {
    const built = buildStepFromPayload(payload, position);
    if (!built) return definition;
    const base = asDefinition(definition);
    if (built.type === 'trigger') return placeTrigger(base, built as BuiltTrigger, definition) as T | FlowDefinition;

    const steps = [...base.steps, built as FlowStep];
    const edges: FlowEdge[] =
        sourceId && built.type !== 'note' ? [...base.edges, { from: sourceId, to: built.id, ...branchFromHandle(sourceHandle) }] : base.edges;
    return seedPositions({ ...base, steps, edges });
}

/** Would adding edge `from → to` close a loop? True when `from` is reachable from `to`. */
export function createsCycle(def: DefinitionInput, from: string, to: string): boolean {
    const adj = new Map<string, string[]>();
    for (const e of def?.edges || []) {
        const list = adj.get(e.from) ?? [];
        list.push(e.to);
        adj.set(e.from, list);
    }
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
        const cur = stack.pop() as string;
        if (cur === from) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of adj.get(cur) || []) stack.push(next);
    }
    return false;
}

/** The id of the node `applyAddNode` just added: the last step, or the new trigger. */
export function addedNodeId(before: DefinitionInput, after: DefinitionInput): string | null {
    const had = new Set([before?.trigger?.id, ...(before?.triggers || []).map((t) => t.id), ...(before?.steps || []).map((s) => s.id)]);
    const now = [after?.trigger, ...(after?.triggers || []), ...(after?.steps || [])];
    return now.find((n) => n && !had.has(n.id))?.id ?? null;
}
