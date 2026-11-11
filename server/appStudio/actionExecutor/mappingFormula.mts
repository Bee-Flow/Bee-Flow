/**
 * App Studio action executor — an input mapping of kind `formula` (run_automation, schema version 3).
 *
 * `{ kind: 'formula', expr }` is worked out ON THE SERVER, in the server scope of the step (or, for a bare
 * run_automation action, of the run request), when the automation starts. The browser never sends the
 * value: it sends what the scope is built from, as for every other server-side formula.
 *
 * Both bridges of automationBridge.js read it: the typed app-trigger bridge takes the value as it is and
 * checks it against the declared param like any other input; the legacy bridge takes a primitive only,
 * as it does for a `field`.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { tryEvaluate } = nodeRequire('../../shared/expr/index.mjs') as { tryEvaluate: (expr: string, scope: unknown) => { value?: unknown } | null | undefined };
const { buildServerScope } = nodeRequire('./shared.js') as { buildServerScope: (ctx: Record<string, unknown>) => unknown };

export type EvalFormula = (expr: string) => unknown;
type Mapping = { expr?: unknown };

/** The evaluator of one run: the scope is built once, on the first formula. */
export function formulaEvaluator(ctx: Record<string, unknown>): EvalFormula {
    let scope: unknown;
    let built = false;
    return (expr) => {
        if (!built) { scope = buildServerScope(ctx); built = true; }
        return tryEvaluate(expr, scope)?.value;
    };
}

/** The value of a formula mapping: undefined without an evaluator, without a formula, or when it gives nothing. */
export function formulaValue(mapping: Mapping, evalFormula: EvalFormula | undefined): unknown {
    if (typeof evalFormula !== 'function' || typeof mapping.expr !== 'string' || !mapping.expr.trim()) return undefined;
    const value = evalFormula(mapping.expr);
    return value === null ? undefined : value;
}

/**
 * The legacy bridge: put the formula's value under `param`. Nothing is put for no value; a value that is
 * not a string, number or boolean is refused with a 400, as a `field` mapping refuses one.
 */
export function putFormulaInput(inputs: Record<string, unknown>, param: string, mapping: Mapping, evalFormula: EvalFormula | undefined, capString: (v: unknown) => unknown): void {
    const value = formulaValue(mapping, evalFormula);
    if (value === undefined) return;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw Object.assign(new Error(`The formula for "${param}" must give a string, number or boolean`), { status: 400 });
    }
    inputs[param] = capString(value);
}
