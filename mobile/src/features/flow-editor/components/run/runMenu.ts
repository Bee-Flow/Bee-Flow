/**
 * What the builder's run menu offers and what a run is sent with — the web's
 * RunFlowMenu (BuilderHeader.jsx) and BuilderShell's `runBody`. Pure.
 *
 *   - "Start from" lists the routine's entry points — the primary, then each
 *     additional trigger — and only when there is more than one;
 *   - every run enters with its trigger's saved sample (`pinnedOutput`: a
 *     captured run or a payload the author typed, BFSF-408), and one started
 *     from an additional trigger names it, so the server seeds the run there;
 *   - a form trigger with no sample has nothing to run WITH: a live run of it
 *     is a person filling the form in, so the builder opens the trigger
 *     instead (the web opens the form over the canvas).
 */

import { triggerTypeLabel, type FlowDefinition, type FlowTrigger } from '@/features/flow-editor/model';

export interface StartPoint {
    /** The trigger's id; null for the primary. */
    id: string | null;
    label: string;
}

export interface RunInput {
    triggerPayload?: unknown;
    triggerStepId?: string;
}

const secondaries = (def: FlowDefinition | null | undefined): FlowTrigger[] =>
    (Array.isArray(def?.triggers) ? def.triggers : []).filter((t): t is FlowTrigger => !!t && typeof t.id === 'string' && !!t.id);

/** The entry points "Start from" offers; empty for a routine with one trigger. */
export function startPoints(def: FlowDefinition | null | undefined): StartPoint[] {
    const extra = secondaries(def);
    if (!extra.length) return [];
    const primary = def?.trigger;
    return [
        { id: null, label: primary?.label || triggerTypeLabel(primary) },
        ...extra.map((t) => ({ id: t.id, label: t.label || triggerTypeLabel(t) })),
    ];
}

/** The chosen start, or null (the primary) when it is gone from the routine. */
export function currentStart(def: FlowDefinition | null | undefined, from: string | null): string | null {
    return from && secondaries(def).some((t) => t.id === from) ? from : null;
}

/** The trigger a run enters through. */
export function entryTrigger(def: FlowDefinition | null | undefined, from: string | null): FlowTrigger | null {
    const id = currentStart(def, from);
    return (id ? secondaries(def).find((t) => t.id === id) : def?.trigger) ?? null;
}

/** The body of a whole-flow run (and a step run, which enters the same way): the web's runBody. */
export function runInputFor(def: FlowDefinition | null | undefined, from: string | null = null): RunInput {
    const id = currentStart(def, from);
    const sample = entryTrigger(def, id)?.pinnedOutput;
    return {
        ...(sample == null ? {} : { triggerPayload: sample }),
        ...(id ? { triggerStepId: id } : {}),
    };
}

/** A form trigger with no saved answers to run on: the id to open instead of running live. */
export function bareFormEntry(def: FlowDefinition | null | undefined, from: string | null): string | null {
    const entry = entryTrigger(def, from);
    return entry && entry.kind === 'form' && entry.pinnedOutput == null ? entry.id : null;
}
