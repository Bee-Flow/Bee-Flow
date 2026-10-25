import type { ScopeStep, ScopeGraph } from './flowletScope.types';

/**
 * Where a flowlet is called from, as scope keys ('root' or a flowlet key),
 * one entry per call site. `countLayerRefs` gives the raw total; this names
 * the places, which is what a confirmation prompt needs to be honest about.
 *
 * @param {object|null} def whole (root) definition
 * @param {string} key
 * @returns {string[]}
 */
export function layerCallScopes(def: ScopeGraph | null | undefined, key: string) {
    if (!def || !key) return [];
    const out: string[] = [];
    const scopes: Array<[string, ScopeStep[]]> = [
        ['root', def.steps || []],
        ...Object.entries(def.layers || {}).map(([k, layer]): [string, ScopeStep[]] => [k, layer?.steps || []]),
    ];
    for (const [scope, steps] of scopes) {
        for (let i = countCallsTo(steps, key); i > 0; i -= 1) out.push(scope);
    }
    return out;
}

/** How many call_layer steps (nested ones included) in `steps` call the flowlet `key`. */
export function countCallsTo(steps: ScopeStep[] | null | undefined, key: string): number {
    let n = 0;
    for (const step of walkSteps(steps)) {
        if (step?.type === 'call_layer' && step.layerKey === key) n += 1;
    }
    return n;
}

/**
 * Depth-first walk over a steps array, descending into loop bodies
 * (`step.body`) and parallel branches (`step.branches` — either arrays
 * of steps or `{steps: []}` objects).
 */
export function* walkSteps(steps: ScopeStep[] | null | undefined): Generator<ScopeStep> {
    for (const step of steps || []) {
        if (!step) continue;
        yield step;
        if (Array.isArray(step.body)) yield* walkSteps(step.body);
        if (Array.isArray(step.branches)) {
            for (const branch of step.branches) {
                if (Array.isArray(branch)) yield* walkSteps(branch);
                else if (Array.isArray(branch?.steps)) yield* walkSteps(branch.steps);
            }
        }
    }
}
