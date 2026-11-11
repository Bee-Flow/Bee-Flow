/**
 * App Studio validator — what a formula can read where the SERVER works it out (schema version 3 additions
 * included):
 *
 * - A server step's formula that reads a root the server has no value for (`screen`, `forms`, `actions`,
 *   `records`, `datasets`, `connectors`) is a warning, for every schema version: it gives nothing there.
 *   An app that sets `serverScope: 'wide'` has `screen`, `forms` and `actions` on the server (sent by the
 *   browser with a step of a click), so those three are then fine.
 * - `guard` on a server step is such a formula. A step inside a transaction takes none of its own: the
 *   writes of a transaction land together, so the guard belongs on the transaction.
 * - An input mapping of kind `formula` (run_automation) carries a formula string.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { compile } = nodeRequire('../../shared/expr/index.mjs') as { compile: (expr: string) => { refs: string[] } };
const { SERVER_SCOPE_ROOTS } = nodeRequire('../actionExecutor/shared.js') as { SERVER_SCOPE_ROOTS: readonly string[] };
const { STEP_SPECS } = nodeRequire('../componentSpecs/actionSpecs.js') as { STEP_SPECS: Record<string, { fields: Record<string, { type?: string }> } | undefined> };
const { INPUT_MAPPING_KINDS } = nodeRequire('../componentSpecs/bindings.js') as { INPUT_MAPPING_KINDS: string[] };
const { INPUT_MAPPING_KIND_SINCE } = nodeRequire('../componentSpecs/actionSpecsServer.js') as { INPUT_MAPPING_KIND_SINCE: Record<string, number> };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; serverScopeWide?: boolean };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The wide server scope of a definition: the one value `serverScope` takes. */
export const SERVER_SCOPE_WIDE = 'wide';
/** The roots the browser sends along for an app with the wide scope. */
export const WIDE_SCOPE_ROOTS: readonly string[] = Object.freeze(['screen', 'forms', 'actions']);
/** Declared roots of the server scope that never hold a value there. */
const EMPTY_ON_SERVER: readonly string[] = Object.freeze(['records', 'datasets']);

/** What validate.js spreads into its context for the keys a person or a since-3 flag sets on the definition. */
export function since3Ctx(def: Obj): { allowedLinkHosts: string[]; serverScopeWide: boolean } {
    return {
        allowedLinkHosts: Array.isArray(def.allowedLinkHosts) ? def.allowedLinkHosts as string[] : [],
        serverScopeWide: def.serverScope === SERVER_SCOPE_WIDE,
    };
}

/** Every kind an input mapping entry may have: the base kinds, then the ones added after it. */
export function mappingKinds(): string[] {
    return [...INPUT_MAPPING_KINDS, ...Object.keys(INPUT_MAPPING_KIND_SINCE)];
}

/** The roots of `expr` the server has no value for (an unparseable formula is another check's finding). */
export function unfilledServerRoots(expr: string, wide: boolean): string[] {
    let refs: string[];
    try { ({ refs } = compile(expr)); } catch { return []; }
    return [...new Set(refs)].filter((root) => EMPTY_ON_SERVER.includes(root)
        || (WIDE_SCOPE_ROOTS.includes(root) && !wide)
        || (root === 'connectors' && !SERVER_SCOPE_ROOTS.includes(root)));
}

/** Warn when a formula of a server step reads a root that is empty on the server. */
export function checkServerScopeRoots(expr: unknown, path: string, ctx: Ctx): void {
    if (typeof expr !== 'string' || !expr) return;
    for (const root of unfilledServerRoots(expr, ctx.serverScopeWide === true)) {
        const widenable = WIDE_SCOPE_ROOTS.includes(root);
        ctx.pushW({
            code: 'formula.server_scope_empty', severity: 'warning', path,
            message: `This step runs on the server, where "${root}" has no value, so this formula gives nothing there.`,
            hint: widenable
                ? `Put the value in a variable first (a "Set a variable" step, then read vars.<name>), or set the app's serverScope to "${SERVER_SCOPE_WIDE}" so the browser sends screen, forms and actions with each server step of a click.`
                : 'Read the rows in the browser first: put what you need in a variable (a "Set a variable" step) and read vars.<name> here.',
        });
    }
}

/** The plain formula fields of a server step (`guard`, and any other field of type formula). */
function checkFormulaFields(step: Obj, path: string, ctx: Ctx): void {
    const fields = STEP_SPECS[String(step.kind)]?.fields || {};
    for (const [field, spec] of Object.entries(fields)) {
        if (spec?.type === 'formula') checkServerScopeRoots(step[field], `${path}.${field}`, ctx);
    }
}

/** A transaction's children are committed as one write: none of them is run, or skipped, on its own. */
function checkTransactionGuards(step: Obj, path: string, ctx: Ctx): void {
    if (step.kind !== 'transaction' || !Array.isArray(step.steps)) return;
    step.steps.forEach((child, i) => {
        if (!isObject(child) || child.guard === undefined) return;
        ctx.pushE({
            code: 'action.transaction_child_guard', severity: 'error', path: `${path}.steps[${i}].guard`,
            message: `Step ${i + 1} of the transaction has its own guard; the writes of a transaction land together or not at all.`,
            hint: 'Put the guard on the transaction step itself.',
        });
    });
}

/** The checks of one server step that its bindings do not cover (called once per server step). */
export function checkServerStep(step: unknown, path: string, ctx: Ctx): void {
    if (!isObject(step)) return;
    checkFormulaFields(step, path, ctx);
    checkTransactionGuards(step, path, ctx);
}

/**
 * An input mapping entry of kind `formula`: `expr` is a formula string (its roots are checked where the step
 * is). `owner` is the label validateInputMapping got: `<kind>.<field>` for a step, the action id (which has
 * no dot) for a run_automation action on its own, where nothing works a formula out.
 */
export function checkMappingFormula(entry: Obj, owner: string, param: string, path: string, ctx: Ctx, validateFormula: (expr: unknown, path: string, ctx: Ctx) => void): void {
    if (!owner.includes('.')) {
        ctx.pushE({ code: 'action.mapping_formula_bare_action', severity: 'error', path, message: `The input "${param}" is a formula, which only a run_automation step of a sequence works out.`, hint: 'Make the action a sequence with one run_automation step, or use a static or field mapping.' });
        return;
    }
    if (typeof entry.expr !== 'string' || !entry.expr.trim()) {
        ctx.pushE({ code: 'action.mapping_formula_missing', severity: 'error', path, message: `Formula mapping for "${param}" needs an \`expr\`.`, hint: 'Write a formula such as vars.customerId or concat(form.first, " ", form.last).' });
        return;
    }
    validateFormula(entry.expr, `${path}.expr`, ctx);
}
