/**
 * App Studio builder tools — shared internals for the sibling tool modules.
 *
 * The v2 node-field normalizers (visibleWhen/computed/validations), idHint,
 * adoptCanonical (THE common tail of every mutating tool) and the
 * string-bounding helpers the plan/template tools cap input with. Required
 * only from within appStudio/builderTools/.
 */

'use strict';

const { LIMITS } = require('../componentSpecs');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { pickClosestId } = require('../../automation/validate/helpers');
const { NODE_VALIDATION_TYPES } = require('./schemas');

// v2 node-level logic fields the AI may author on add/update. The node shape
// for the When-flags is boolean | {kind:'formula',expr}; the tools also accept
// a bare expression string and wrap it (canonicalize/validate handle the rest).
//
// `readOnly` sat in canonicalize + validate + the renderer for a whole release
// without ever being listed here, which meant no tool call could set it.
const NODE_LOGIC_FIELDS = ['visibleWhen', 'enabledWhen', 'readOnly', 'visibleToRoles'];

// The two node fields that are NOT a boolean-or-formula flag: `computed` maps
// prop keys to formulas (making ANY prop live — the only escape hatch for the
// 22 component types with no binding-typed prop), `validations` attaches input
// rules. Same story as readOnly: canonicalized, validated and RENDERED, but
// unreachable from the tool layer, so the model could only conclude that live
// text on a heading was architecturally impossible. It never was.
const NODE_VALUE_FIELDS = ['computed', 'validations'];

// Everything a component entry / update patch may carry beyond props+style.
const NODE_AUTHORABLE_FIELDS = [...NODE_LOGIC_FIELDS, ...NODE_VALUE_FIELDS];

/**
 * Normalize one logic-field value from tool args to the node shape.
 * Returns { value } or { error }.
 */
function normalizeLogicValue(field, v) {
    if (field === 'visibleToRoles') {
        if (Array.isArray(v) && v.every((r) => typeof r === 'string' && r)) return { value: v };
        return { error: `${field} must be an array of role key strings (from definition.roles).` };
    }
    if (typeof v === 'boolean') return { value: v };
    if (typeof v === 'string' && v.trim()) return { value: { kind: 'formula', expr: v } };
    if (v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'formula' && typeof v.expr === 'string') {
        return { value: { kind: 'formula', expr: v.expr } };
    }
    return { error: `${field} must be a formula expression string (e.g. "form.email != ''"), a boolean, or {kind:"formula",expr}.` };
}

/**
 * Normalize node.computed — { propKey: <expr string> | {kind:'formula',expr} }.
 * The bare-string form is accepted for the same reason the When-flags accept
 * one: it is what a model writes first, and wrapping it here is cheaper than a
 * rejected call. Returns { value } or { error }.
 */
function normalizeComputed(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { error: 'computed must be an object mapping prop keys to formulas, e.g. { "text": "concat(\'Total: \', toStr(vars.total))" } or { "text": {kind:"formula",expr:"vars.total"} }.' };
    }
    const out = {};
    for (const [propKey, entry] of Object.entries(v)) {
        if (typeof entry === 'string' && entry.trim()) {
            out[propKey] = { kind: 'formula', expr: entry };
            continue;
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.kind === 'formula' && typeof entry.expr === 'string') {
            out[propKey] = { kind: 'formula', expr: entry.expr };
            continue;
        }
        return { error: `computed.${propKey} must be a formula expression string or {kind:"formula",expr} (got ${JSON.stringify(entry)}).` };
    }
    return { value: out };
}

/**
 * Normalize node.validations — [{ type, … }]. Only the shape the canonicalizer
 * cannot repair is rejected here (non-array, non-object rule, unknown type);
 * per-rule field checks stay with validate.js so there is ONE authority.
 * Returns { value } or { error }.
 */
function normalizeValidations(v) {
    if (!Array.isArray(v)) {
        return { error: `validations must be an array of rules, e.g. [{type:"required"},{type:"minLength",value:3}]. Legal types: ${NODE_VALIDATION_TYPES.join(', ')}.` };
    }
    if (v.length > LIMITS.MAX_VALIDATIONS_PER_FIELD) {
        return { error: `validations: max ${LIMITS.MAX_VALIDATIONS_PER_FIELD} rules per component.` };
    }
    const out = [];
    for (const [i, rule] of v.entries()) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            return { error: `validations[${i}] must be an object { type, … }.` };
        }
        if (!NODE_VALIDATION_TYPES.includes(rule.type)) {
            const suggestion = pickClosestId(rule.type, NODE_VALIDATION_TYPES);
            return { error: `validations[${i}].type ${JSON.stringify(rule.type)} is not a validation type.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Legal types: ${NODE_VALIDATION_TYPES.join(', ')}.` };
        }
        out.push({ ...rule });
    }
    return { value: out };
}

/** Normalize any authorable node field. Returns { value } or { error }. */
function normalizeNodeField(field, v) {
    if (field === 'computed') return normalizeComputed(v);
    if (field === 'validations') return normalizeValidations(v);
    return normalizeLogicValue(field, v);
}

function idHint(def) {
    const screens = (def.screens || []).map((s) => s.id);
    const sections = (def.screens || []).flatMap((s) => (s.sections || []).map((x) => x.id));
    return `Known screen ids: ${screens.join(', ') || '(none)'}; section ids: ${sections.join(', ') || '(none)'}.`;
}

// Repairs that are EXPECTED behaviour (spec defaults being materialized),
// not a mistake worth echoing back to the model — the catalog already
// documents every default. Everything else (clamps, dropped keys, hoists,
// re-keyed ids, wrapped bindings) is a teaching signal and stays.
const BENIGN_REPAIR_CODES = new Set(['props.defaulted', 'section.style_defaulted']);

/**
 * Canonicalize `nextDef`, adopt it as the live draft, and decorate `result`
 * with the canonicalizer's repair hints (clamps, dropped keys, hoists, …).
 * This is THE common tail of every mutating tool.
 */
function adoptCanonical(draftWrap, nextDef, result) {
    const { def, repairs } = canonicalizeAppDefinition(nextDef);
    draftWrap.def = def;
    const teachable = repairs.filter((r) => !BENIGN_REPAIR_CODES.has(r.code));
    if (teachable.length) {
        result._hints = teachable.map((r) => (r.path ? `${r.path}: ${r.message}` : r.message));
    }
    return result;
}

/** Trim + cap a single string; undefined when not a usable string. */
function capStr(v, max) {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s) return undefined;
    return s.length > max ? s.slice(0, max) : s;
}

/** Cap an array of strings by item count and per-item length; undefined when empty. */
function capStrArray(v, maxItems, maxLen) {
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const item of v) {
        const s = capStr(item, maxLen);
        if (s !== undefined) out.push(s);
        if (out.length >= maxItems) break;
    }
    return out.length ? out : undefined;
}

module.exports = {
    NODE_LOGIC_FIELDS,
    NODE_VALUE_FIELDS,
    NODE_AUTHORABLE_FIELDS,
    normalizeLogicValue,
    normalizeComputed,
    normalizeValidations,
    normalizeNodeField,
    idHint,
    adoptCanonical,
    capStr,
    capStrArray,
};
