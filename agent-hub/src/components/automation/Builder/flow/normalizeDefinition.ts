import type { FlowDefinition, FlowEdge, FlowStep } from './types';

/** A step with the canvas position the builder stores on it. */
export interface PositionedStep extends FlowStep {
    position?: { x?: number; y?: number };
}

/** A definition whose `steps` and `edges` are known to be arrays. */
export interface NormalizedDefinition extends FlowDefinition {
    steps: PositionedStep[];
    edges: FlowEdge[];
}

/**
 * Shape guards for automation definitions (BFSF-318).
 *
 * The server validator hard-rejects a definition whose `steps`/`edges` are not
 * arrays (`automation/validate.js` — `steps.not_array` / `edges.not_array`), and
 * it early-returns on that failure, so the user sees only the shape complaint
 * with no hint about what actually went wrong.
 *
 * Two things conspired to produce such a definition:
 *
 *   1. An empty object `{}` is TRUTHY, so every `def || seed` fallback in the
 *      builder chain (BuilderShell's `effectiveDef`, BuildTab's `baseDef`,
 *      useAutomationBuilderStream's `hydrate`) happily adopted it as a real
 *      definition instead of falling through to the well-formed seed.
 *   2. `applyAddNode`'s trigger branch is a key-preserving spread — given `{}`
 *      it emits `{ trigger }` and nothing else, and `seedPositions` early-returns
 *      when every node already has a position, so nothing backfills the arrays.
 *
 * `isBlankDefinition` fixes (1) — treat a definition with no trigger and no
 * steps as absent so the seed wins. `normalizeDefinitionShape` fixes (2) — and
 * is applied at every boundary where a definition crosses the network.
 *
 * Both are pure; the input is never mutated.
 */

/**
 * True when `def` carries no actual graph — null/undefined, a non-object, or an
 * object with neither a trigger nor any steps (e.g. the poisoned `{}`).
 *
 * Callers use this in place of a truthiness check so a blank definition falls
 * through to their seed.
 */
export function isBlankDefinition(def: NonNullable<unknown> | null | undefined): boolean;
export function isBlankDefinition(def: FlowDefinition | null | undefined): boolean {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return true;
    const hasTrigger = !!def.trigger && typeof def.trigger === 'object';
    const hasSteps = Array.isArray(def.steps) && def.steps.length > 0;
    const hasTriggers = Array.isArray(def.triggers) && def.triggers.length > 0;
    return !hasTrigger && !hasSteps && !hasTriggers;
}

/**
 * Return `def` with `steps` and `edges` guaranteed to be arrays. Every other
 * key (trigger, triggers, layers, vars, schemaVersion, …) is preserved as-is.
 *
 * Returns null for a nullish/non-object input so callers can keep using
 * `normalizeDefinitionShape(x) || seed` — it never invents a definition out of
 * nothing.
 */
export function normalizeDefinitionShape(def: NonNullable<unknown> | null | undefined): NormalizedDefinition | null;
export function normalizeDefinitionShape(def: FlowDefinition | null | undefined): NormalizedDefinition | null {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return null;
    const stepsOk = Array.isArray(def.steps);
    const edgesOk = Array.isArray(def.edges);
    if (stepsOk && edgesOk) return def as NormalizedDefinition; // already well-formed — don't churn identity
    return {
        ...def,
        steps: stepsOk ? def.steps as PositionedStep[] : [],
        edges: edgesOk ? def.edges as FlowEdge[] : [],
    };
}

/** The canonical empty graph the builder seeds a fresh canvas with. */
export function emptyGraph(): NormalizedDefinition {
    return { trigger: null, steps: [], edges: [] };
}
