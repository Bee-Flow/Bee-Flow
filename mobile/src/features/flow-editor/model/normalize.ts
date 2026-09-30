/**
 * Shape guards for automation definitions — a port of the web builder's
 * flow/normalizeDefinition.js (BFSF-318), pinned by normalize.lockstep.test.ts.
 *
 * The server validator hard-rejects a definition whose `steps`/`edges` are not
 * arrays, and stops there, so the author sees only the shape complaint. An
 * empty object `{}` is truthy, which is how one used to slip past every
 * `def || seed` fallback. `isBlankDefinition` treats it as absent;
 * `normalizeDefinitionShape` guarantees the two arrays at every boundary.
 *
 * Both are pure; the input is never mutated.
 */

import type { DefinitionInput, FlowDefinition } from './types';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * True when `def` carries no actual graph: nullish, not an object, or an
 * object with no trigger, no secondary trigger and no step.
 */
export function isBlankDefinition(def: unknown): boolean {
    if (!isObject(def)) return true;
    const hasTrigger = !!def.trigger && typeof def.trigger === 'object';
    const hasSteps = Array.isArray(def.steps) && def.steps.length > 0;
    const hasTriggers = Array.isArray(def.triggers) && def.triggers.length > 0;
    return !hasTrigger && !hasSteps && !hasTriggers;
}

/**
 * `def` with `steps` and `edges` guaranteed to be arrays; every other key is
 * kept. Null for a nullish or non-object input, so `normalize(x) ?? seed`
 * never invents a definition out of nothing. A well-formed input comes back
 * as the SAME object, so nothing downstream re-renders for free.
 */
export function normalizeDefinitionShape(def: unknown): FlowDefinition | null {
    if (!isObject(def)) return null;
    const stepsOk = Array.isArray(def.steps);
    const edgesOk = Array.isArray(def.edges);
    if (stepsOk && edgesOk) return def as FlowDefinition;
    return {
        ...def,
        steps: stepsOk ? (def.steps as FlowDefinition['steps']) : [],
        edges: edgesOk ? (def.edges as FlowDefinition['edges']) : [],
    } as FlowDefinition;
}

/** The canonical empty graph a fresh canvas is seeded with. */
export function emptyGraph(): FlowDefinition {
    return { trigger: null, steps: [], edges: [] };
}

/** `normalizeDefinitionShape(def)`, or a fresh empty graph. */
export function asDefinition(def: DefinitionInput | unknown): FlowDefinition {
    return normalizeDefinitionShape(def) ?? emptyGraph();
}
