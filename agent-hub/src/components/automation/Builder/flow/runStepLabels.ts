/**
 * Step labels by id, for the canvas, the validation text and the run viewer.
 *
 * Moved out of displayHelpers.js (which re-exports every name here) so that
 * file keeps room for the rule sentences; the behaviour is unchanged, the
 * types are new.
 */
import type { FlowDefinition, FlowStep } from './types';

// The callers hand over whatever their query returned (the run viewer types
// it as unknown): a definition is read for the members named here only.
type Definition = unknown;
const asDefinition = (def: Definition): FlowDefinition | null => (def && typeof def === 'object' ? def as FlowDefinition : null);

/**
 * Build the lookup map the display helpers need from a definition.
 * Trigger + steps both contribute; falls back to id when a step has
 * no `label` set.
 */
export function buildStepLabelMap(definition: Definition): Map<string, string> {
    const m = new Map<string, string>();
    const def = asDefinition(definition);
    if (!def) return m;
    const all = [def.trigger, ...(def.steps || [])].filter(Boolean) as FlowStep[];
    for (const s of all) m.set(s.id, s.label || s.id);
    return m;
}

// Same ceiling as the runner (server/core/automationRunner/shared.js): a
// deeper call fails there, so nothing below it is ever recorded.
const MAX_LAYER_DEPTH = 8;

/**
 * The run viewer's lookup map (BFSF-457): `buildStepLabelMap` plus every step
 * inside a flowlet, keyed the way the runner records it, `<callId>/<innerId>`,
 * with one more `<callId>/` segment per nested call (execFlow.execCallLayer).
 * Without these, nested rows showed their raw recorded path.
 *
 * Kept apart from `buildStepLabelMap` on purpose: that one also feeds
 * validation text, where only top-level ids mean anything. A layer already on
 * the current call path is not entered again (the runner refuses that
 * recursion too).
 */
export function buildRunStepLabelMap(def: Definition): Map<string, string> {
    const m = buildStepLabelMap(def);
    for (const [id, s] of buildRunStepMap(def)) if (!m.has(id)) m.set(id, s.label || s.id);
    return m;
}

/**
 * Every step of a run's definition by the id the runner records it under:
 * top-level steps and the trigger by their own id, flowlet steps as
 * `<callId>/<innerId>` (one more segment per nested call). The run viewer
 * reads a step's SETTINGS from this (BFSF-456), the labels come from it too.
 */
export function buildRunStepMap(definition: Definition): Map<string, FlowStep> {
    const m = new Map<string, FlowStep>();
    const def = asDefinition(definition);
    if (!def) return m;
    for (const s of [def.trigger, ...(def.steps || [])]) if (s?.id) m.set(s.id, s);
    const layers = def.layers || {};
    const walk = (steps: FlowStep[] | undefined, prefix: string, stack: string[]) => {
        if (stack.length >= MAX_LAYER_DEPTH) return;
        for (const s of steps || []) {
            const key = typeof s?.layerKey === 'string' ? s.layerKey : '';
            if (s?.type !== 'call_layer' || !key || stack.includes(key)) continue;
            const layer = layers[key];
            if (!layer) continue;
            const inner = `${prefix}${s.id}/`;
            for (const x of [layer.trigger, ...(layer.steps || [])]) {
                if (x?.id) m.set(`${inner}${x.id}`, x);
            }
            walk(layer.steps, inner, [...stack, key]);
        }
    };
    walk(def.steps, '', []);
    return m;
}

/**
 * The label for one recorded run-step id, from a `buildRunStepLabelMap` map.
 * A nested id the map does not know (a published Step runs a definition that
 * is not in the run's snapshot) reads as "<call step label> › <inner id>"
 * rather than the bare recorded path.
 */
export function runStepLabel(labelById: Pick<Map<string, string>, 'get'> | null | undefined, stepId: string | null | undefined): string {
    // Not an id: handed back as it came, as it always was.
    if (typeof stepId !== 'string' || !stepId) return stepId as string;
    const known = labelById?.get(stepId);
    if (known) return known;
    const cut = stepId.lastIndexOf('/');
    if (cut <= 0) return stepId;
    return `${runStepLabel(labelById, stepId.slice(0, cut))} › ${stepId.slice(cut + 1)}`;
}
