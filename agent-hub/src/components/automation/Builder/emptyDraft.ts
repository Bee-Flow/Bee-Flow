import type { FlowDefinition } from './flow/types';

/**
 * A draft nobody has built anything in yet: no steps, no extra entry points,
 * and at most the manual start a new automation is created with. On such a
 * draft the first question is "what should happen?", and the assistant is
 * the one who asks it: the builder opens with the assistant visible and its
 * welcome offers to ask a few questions first.
 */
export function isEmptyDraft(def: FlowDefinition | null | undefined): boolean {
    if (!def || typeof def !== 'object') return true;
    if (Array.isArray(def.steps) && def.steps.length > 0) return false;
    if (Array.isArray(def.triggers) && def.triggers.length > 0) return false;
    const kind = def.trigger?.kind;
    return !def.trigger || !kind || kind === 'manual';
}
