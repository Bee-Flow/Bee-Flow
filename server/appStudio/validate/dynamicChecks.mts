/**
 * App Studio validator — the "dynamic text and effects" additions (schema version 3).
 *
 * - A toast, confirm, navigate or open_url step may carry a formula (`messageExpr`, `screenExpr`,
 *   `urlExpr`, ...) beside the literal field. A literal field the formula stands in for is no longer
 *   required (coveredByExpr), so a step with only the formula is complete.
 * - A switch case may carry `whenExpr`, a formula, instead of `value`.
 * - An open_url formula only opens hosts the person listed in `allowedLinkHosts`; without a list it can
 *   never open, which is worth a warning at save time.
 * - A sequence's onSuccess/onError are effects (a toast and/or a screen to open), checked like a
 *   run_automation's.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { validateFormula } = nodeRequire('./formulas.js') as { validateFormula: (expr: unknown, path: string, ctx: Ctx, roots?: unknown) => void };
const { FORMULA_SCOPE_ROOTS } = nodeRequire('../componentSpecs') as { FORMULA_SCOPE_ROOTS: unknown };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; allowedLinkHosts?: string[] };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The literal field a formula field stands in for: `<kind>.<literal>` → its formula field. */
const FORMULA_FOR: Record<string, Record<string, string>> = {
    toast: { message: 'messageExpr' },
    confirm: { message: 'messageExpr' },
    navigate: { screenId: 'screenExpr' },
    open_url: { url: 'urlExpr' },
};

/** True when `field` is absent (or empty) on the step and its formula field is there: nothing is missing. */
export function coveredByExpr(step: Obj, field: string): boolean {
    const formulaField = FORMULA_FOR[String(step.kind)]?.[field];
    return !!formulaField && (step[field] === undefined || step[field] === null || step[field] === '') && typeof step[formulaField] === 'string' && step[formulaField] !== '';
}

/** open_url: a formula address needs a list of hosts it may open. */
export function checkOpenUrl(step: Obj, path: string, ctx: Ctx): void {
    if (typeof step.urlExpr !== 'string' || !step.urlExpr || (ctx.allowedLinkHosts || []).length) return;
    ctx.pushW({
        code: 'action.url_expr_no_hosts', severity: 'warning', path: `${path}.urlExpr`,
        message: 'This open_url builds its address with a formula, but the app lists no allowed hosts, so it can never open.',
        hint: 'Ask the app owner to add the hosts in the app settings (allowedLinkHosts), or use a literal https url.',
    });
}

/** switch: the formula of a case that picks by `whenExpr`. */
export function checkSwitchCases(step: Obj, path: string, ctx: Ctx): void {
    const cases = Array.isArray(step.cases) ? step.cases : [];
    cases.forEach((c, i) => {
        if (!isObject(c) || c.whenExpr === undefined) return;
        if (typeof c.whenExpr !== 'string' || !c.whenExpr) {
            ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}.cases[${i}].whenExpr`, message: 'A switch case `whenExpr` must be a formula string.', hint: 'Write a formula such as vars.score >= 10, or use `value` to compare with the switch formula.' });
            return;
        }
        validateFormula(c.whenExpr, `${path}.cases[${i}].whenExpr`, ctx, FORMULA_SCOPE_ROOTS);
    });
}

/** A sequence action's onSuccess / onError effects. */
export function checkSequenceEffects(action: Obj, path: string, ctx: Ctx, validateEffects: (e: unknown, p: string, c: Ctx) => void): void {
    if (action.onSuccess !== undefined) validateEffects(action.onSuccess, `${path}.onSuccess`, ctx);
    if (action.onError !== undefined) validateEffects(action.onError, `${path}.onError`, ctx);
}
