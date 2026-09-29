/**
 * App Studio validator — formula checks: parse-compilation with the shared
 * expr engine (NEVER execution), unknown-root and `vars.<name>` read
 * warnings, and the server-side currentUser scope rules.
 */

'use strict';

const { LIMITS, FORMULA_SCOPE_ROOTS, CURRENT_USER_KEYS } = require('../componentSpecs');
// The shared expr engine, via server/automation/expr.js — the project's CJS
// re-export of shared/expr/index.mjs. Going through this boundary (rather than
// require()-ing the .mjs directly) keeps App Studio on the CommonJS surface the
// rest of the server uses and is transparent to the route/store test harnesses
// that monkeypatch Module._resolveFilename.
const { compile } = require('../../automation/expr');

// ---------------------------------------------------------------------------
// v2 shared checks — formula compilation (NEVER execution), and reference
// resolution for tables/datasets/automations (publish-gated like automationId).
// ---------------------------------------------------------------------------

// Syntax-check a formula string with the shared compiler and flag any root
// identifier outside the app's scope. NEVER evaluates.
function validateFormula(expr, path, ctx, allowedRoots) {
    const { pushE, pushW } = ctx;
    if (typeof expr !== 'string') {
        pushE({ code: 'formula.type', severity: 'error', path, message: 'A formula `expr` must be a string.', hint: 'Provide an expression string like "form.total > 0".' });
        return;
    }
    if (expr.length > LIMITS.MAX_FORMULA_LEN) {
        pushE({ code: 'formula.too_long', severity: 'error', path, message: `Formula is ${expr.length} chars — the maximum is ${LIMITS.MAX_FORMULA_LEN}.`, hint: 'Shorten the expression.' });
        return;
    }
    let refs;
    try {
        refs = compile(expr).refs;
    } catch (e) {
        const idx = e && typeof e.index === 'number' ? e.index : null;
        pushE({ code: 'formula.parse_error', severity: 'error', path, message: `Formula failed to parse${idx != null ? ` at position ${idx}` : ''}: ${e && e.message ? e.message : String(e)}.`, hint: 'Fix the expression syntax; only the whitelisted functions/operators are allowed.' });
        return;
    }
    const roots = allowedRoots || FORMULA_SCOPE_ROOTS;
    for (const r of refs) {
        if (!roots.includes(r)) {
            pushW({ code: 'unknown_formula_root', severity: 'warning', path, message: `Formula references unknown root "${r}" — it resolves to undefined at runtime.`, hint: `In-scope roots: ${roots.join(', ')}.` });
        }
    }
    checkVariableReads(expr, path, ctx);
}

// `vars.<name>` reads, extracted from the source text — compile().refs reports
// the ROOT only, so the name after the dot has to come off the string, exactly
// as CURRENT_USER_ATTR_RE does for currentUser.
const VARS_ATTR_RE = /\bvars\s*\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * Flag a `vars.<name>` nothing anywhere puts a value in.
 *
 * This is the failure from which the whole declared-variables feature grew:
 * `vars.statusfilter` where `vars.filters.status` was meant resolves to
 * undefined, resolveBindingFilters DROPS the filter entry, and the component
 * cheerfully lists every row in the table with no signal anywhere.
 *
 * Three rules keep it from punishing anyone:
 *  - it is a WARNING, so it can never fail a save or block a publish;
 *  - it is SKIPPED ENTIRELY unless the app declares variables (ctx.knownVars is
 *    null otherwise), so not one existing app gains a warning it did not have;
 *  - the known set is declared ∪ WRITTEN, so declaring one variable does not
 *    suddenly indict every set_variable the AI had already introduced. Adopting
 *    the feature must not be punished.
 */
function checkVariableReads(expr, path, ctx) {
    if (!ctx.knownVars || typeof expr !== 'string' || !expr) return;
    for (const m of expr.matchAll(VARS_ATTR_RE)) {
        const name = m[1];
        if (ctx.varReads) ctx.varReads.add(name);
        if (ctx.knownVars.has(name)) continue;
        ctx.pushW({
            code: 'formula.unknown_variable', severity: 'warning', path,
            message: `Nothing gives "vars.${name}" a value — it resolves to nothing, and a filter using it is dropped.`,
            hint: ctx.knownVarList && ctx.knownVarList.length
                ? `Declared or written variables: ${ctx.knownVarList.join(', ')}.`
                : 'Declare it under Variables, or set it with a "Set a variable" step.',
        });
    }
}

// `currentUser.<attr>` reads, extracted from a formula string. compile().refs
// only reports ROOTS, so the attribute has to come off the source text.
const CURRENT_USER_ATTR_RE = /\bcurrentUser\s*\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * A formula inside an ACTION STEP runs on the server, where the scope is built
 * by actionExecutor.buildServerScope — not by the browser. An attribute that
 * scope does not carry resolves to undefined and the step writes an empty
 * column, silently.
 *
 * This is the rule that would have caught `currentUser.name`: the editor's
 * scope panel offered it, the browser resolved it, and every activity row an
 * action wrote recorded an empty "Who" for as long as the feature existed.
 * Checked against CURRENT_USER_KEYS — the same list buildServerScope builds
 * from — so the two cannot drift again.
 */
function checkServerFormulaScope(expr, path, ctx) {
    if (typeof expr !== 'string' || !expr) return;
    for (const m of expr.matchAll(CURRENT_USER_ATTR_RE)) {
        const attr = m[1];
        if (CURRENT_USER_KEYS.includes(attr)) continue;
        ctx.pushW({
            code: 'formula.server_scope_unknown', severity: 'warning', path,
            message: `This step runs on the server, where currentUser has no "${attr}" — it resolves to nothing.`,
            hint: `Server-side currentUser carries: ${CURRENT_USER_KEYS.join(', ')}.`,
        });
    }
}

/** Walk a step's authored values for formulas and scope-check each one. */
function checkServerFormulas(value, path, ctx, depth = 0) {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((v, i) => checkServerFormulas(v, `${path}[${i}]`, ctx, depth + 1));
        return;
    }
    if (value.kind === 'formula' && typeof value.expr === 'string') {
        checkServerFormulaScope(value.expr, path, ctx);
        return;
    }
    for (const [k, v] of Object.entries(value)) {
        if (k === 'steps' || k === 'then' || k === 'else' || k === 'cases') continue; // visited as steps
        checkServerFormulas(v, `${path}.${k}`, ctx, depth + 1);
    }
}

module.exports = {
    validateFormula,
    checkServerFormulas,
};
