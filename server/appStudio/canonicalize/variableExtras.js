// @typecheck strict
/**
 * App Studio canonicalizer: the schema 3 keys of one declared variable (scope, persist,
 * derived; shared/appDefinition/variableScopes.mjs says what each means). Each is written
 * only when it is set, after the base keys, so a variable without them keeps its bytes.
 *
 * Repairs, each with a note:
 *   persist: true                     → "session" (the shorter of the two)
 *   derived: "<formula>"              → { expr }  (also { kind: "formula", expr })
 *   derived with scope or persist     → derived only (a worked-out value is neither kept nor reset)
 *   scope "screen" with persist       → scope only (a value that is reset on every screen is not kept)
 * scope "app", persist false / "none" and an empty formula mean the base, and are left out.
 */

'use strict';

const { LIMITS } = require('../componentSpecs/limits');
const { VARIABLE_SCOPES, VARIABLE_PERSIST_MODES } = require('../../shared/appDefinition/variableScopes.mjs');

/** @typedef {(code: string, path: string, message: string) => void} Push */
/** @typedef {{ scope?: string, persist?: string, derived?: { expr: string } }} VariableExtras */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} raw @param {string} path @param {Push} push @returns {string | undefined} */
function cleanScope(raw, path, push) {
    if (raw === undefined || raw === null || raw === 'app') return undefined;
    if (typeof raw === 'string' && VARIABLE_SCOPES.includes(raw)) return raw;
    push('variable.scope_invalid', `${path}.scope`, `Unknown variable scope ${JSON.stringify(raw)}: the variable is shared by the whole app.`);
    return undefined;
}

/** @param {unknown} raw @param {string} path @param {Push} push @returns {string | undefined} */
function cleanPersist(raw, path, push) {
    if (raw === undefined || raw === null || raw === false || raw === 'none') return undefined;
    if (raw === true) {
        push('variable.persist_repaired', `${path}.persist`, 'persist: true kept as "session" (until the browser tab closes); write "local" to keep it longer.');
        return 'session';
    }
    if (typeof raw === 'string' && VARIABLE_PERSIST_MODES.includes(raw)) return raw;
    push('variable.persist_invalid', `${path}.persist`, `Unknown persist mode ${JSON.stringify(raw)}: the value is not kept.`);
    return undefined;
}

/** @param {unknown} raw @param {string} path @param {Push} push @returns {{ expr: string } | undefined} */
function cleanDerived(raw, path, push) {
    if (raw === undefined || raw === null) return undefined;
    const text = typeof raw === 'string' ? raw : isObject(raw) && typeof raw.expr === 'string' ? raw.expr : null;
    if (text === null) {
        push('variable.derived_invalid', `${path}.derived`, 'derived must be { expr: "<formula>" }: dropped.');
        return undefined;
    }
    const expr = text.trim();
    if (!expr) return undefined;
    if (expr.length > LIMITS.MAX_FORMULA_LEN) {
        push('variable.derived_too_long', `${path}.derived.expr`, `The formula is ${expr.length} characters, the maximum is ${LIMITS.MAX_FORMULA_LEN}: dropped.`);
        return undefined;
    }
    const reshaped = typeof raw === 'string' || (isObject(raw) && (raw.kind !== undefined || Object.keys(raw).length !== 1));
    if (reshaped || expr !== text) {
        push('variable.derived_repaired', `${path}.derived`, 'derived written as { expr: "<formula>" }.');
    }
    return { expr };
}

/**
 * The schema 3 keys of `variable`, cleaned, in their fixed order: {} for a variable that has none.
 * @param {Record<string, unknown>} variable
 * @param {string} path
 * @param {Push} push
 * @returns {VariableExtras}
 */
function cleanVariableExtras(variable, path, push) {
    let scope = cleanScope(variable.scope, path, push);
    let persist = cleanPersist(variable.persist, path, push);
    const derived = cleanDerived(variable.derived, path, push);
    if (derived && (scope || persist)) {
        push('variable.derived_extras_dropped', path, 'A derived variable is worked out again each time: its scope and persist were dropped.');
        scope = undefined;
        persist = undefined;
    }
    if (scope && persist) {
        push('variable.persist_dropped', `${path}.persist`, 'A screen variable starts again on every screen, so it is not kept: persist dropped.');
        persist = undefined;
    }
    /** @type {VariableExtras} */
    const out = {};
    if (scope) out.scope = scope;
    if (persist) out.persist = persist;
    if (derived) out.derived = derived;
    return out;
}

module.exports = { cleanVariableExtras };
