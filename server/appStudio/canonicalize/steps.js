// @typecheck
/**
 * App Studio canonicalizer — sequence steps: the per-kind field walk and the
 * control-flow recursion through nested step lists and switch cases.
 */

'use strict';

const { LIMITS, STEP_SPECS } = require('../componentSpecs');
const { HARD_DEPTH_CAP, isObject, deepCopy, truncate, isLateEntry } = require('./shared');
const { cleanBinding, cleanRecordFilter } = require('./bindings');
const { cleanInputMapping, cleanNavParams, cleanCallParams } = require('./mappings');
const { cleanStringList, cleanAiSchema, cleanAiWriteTo, cleanContextSources, cleanTierChoice } = require('./aiFields');
const { cleanApprovalQuestions, cleanApprovalStages, cleanApprovalOnDecided } = require('./approvals');
const { cleanAiChecks } = require('../aiReliability.mts');

// ---------------------------------------------------------------------------
// v2 action sequences — a { kind:'sequence', steps:[Step] } action. Each Step
// is cleaned against STEP_SPECS; control-flow steps (condition/loop/switch)
// recurse. `depth` is the nesting used by the HARD_DEPTH_CAP guard only —
// validate.js enforces MAX_ACTION_DEPTH properly.
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanRecordValues(raw, path, push) {
    if (!isObject(raw)) {
        push('step.field_invalid', path, 'values must be an object map of { column: binding } — reset to {}.');
        return {};
    }
    const out = {};
    for (const [col, v] of Object.entries(raw)) out[col] = cleanBinding(v, `${path}.${col}`, push);
    return out;
}

/**
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanSteps(raw, path, depth, push) {
    if (!Array.isArray(raw)) {
        push('steps.invalid', path, 'steps must be an array — reset to [].');
        return [];
    }
    return raw.map((s, i) => cleanStep(s, `${path}[${i}]`, depth, push));
}

/**
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanSwitchCases(raw, path, depth, push) {
    if (!Array.isArray(raw)) {
        push('steps.invalid', path, 'switch cases must be an array — reset to [].');
        return [];
    }
    return raw.map((c, i) => {
        const cp = `${path}[${i}]`;
        if (!isObject(c)) {
            push('step.invalid', cp, 'Each switch case must be an object { value, steps } — kept for the validator.');
            return deepCopy(c);
        }
        const out = {};
        if (c.value !== undefined) out.value = deepCopy(c.value);
        // since 3: a formula that picks the case when truthy; emitted only when the case carries one. NOT named
        // `when`: stored apps hold cases with a stray `when` that has always been dropped here, and honouring
        // it would change them (compat corpus: lockstep-sample).
        if (typeof c.whenExpr === 'string') out.whenExpr = truncate(c.whenExpr, LIMITS.MAX_FORMULA_LEN, `${cp}.whenExpr`, push);
        else if (c.whenExpr !== undefined) push('step.field_invalid', `${cp}.whenExpr`, 'A case `whenExpr` must be a formula string — dropped.');
        out.steps = cleanSteps(c.steps, `${cp}.steps`, depth, push);
        return out;
    });
}

/**
 * A code step's source text, kept whole: a cut would leave broken code; validate refuses past maxLen.
 * undefined = no value (absent, or dropped with a note).
 *
 * @param {string} field
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 * @returns {string | undefined}
 */
function cleanCodeField(field, v, path, push) {
    if (typeof v === 'string') return v;
    if (v !== undefined) push('step.field_invalid', path, `${field} must be a string of JavaScript — dropped.`);
    return undefined;
}

/**
 * The branches of a parallel step: `[{ steps }]`. A branch keeps only its steps.
 *
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanStepBranches(raw, path, depth, push) {
    if (!Array.isArray(raw)) {
        push('steps.invalid', path, 'branches must be an array of { steps } — reset to [].');
        return [];
    }
    return raw.map((b, i) => {
        if (!isObject(b)) {
            push('step.invalid', `${path}[${i}]`, 'Each branch must be an object { steps } — kept for the validator.');
            return deepCopy(b);
        }
        return { steps: cleanSteps(b.steps, `${path}[${i}].steps`, depth, push) };
    });
}

/** A cleaner's answer for "leave the field out of the step". */
const NO_VALUE = Symbol('no value');

/**
 * @typedef {(arg0: string, arg1: string, arg2: string) => void} Push
 * @typedef {{ raw: any, field: string, fs: StepField & Record<string, any>, path: string, depth: number, push: Push }} FieldCtx
 * @typedef {(v: any, c: FieldCtx) => any} FieldCleaner
 */

/**
 * Cleaned only when the step carries the field; the cleaner's own undefined is
 * stored as given.
 * @param {FieldCleaner} clean
 * @returns {FieldCleaner}
 */
const whenPresent = (clean) => (v, c) => (v === undefined ? NO_VALUE : clean(v, c));
/**
 * Cleaned only when the step carries the field; undefined from the cleaner
 * (dropped with a note) leaves the field out.
 * @param {FieldCleaner} clean
 * @returns {FieldCleaner}
 */
const whenKept = (clean) => (v, c) => {
    if (v === undefined) return NO_VALUE;
    const out = clean(v, c);
    return out === undefined ? NO_VALUE : out;
};

/** @type {FieldCleaner} */
function cleanStringField(v, { field, fs, path, push }) {
    if (typeof v === 'string') return truncate(v, fs.maxLen || LIMITS.MAX_STRING, path, push);
    if (v === null && fs.nullable) return null;
    if (v !== undefined) push('step.field_invalid', path, `${field} must be a string${fs.nullable ? ' or null' : ''} — dropped.`);
    return fs.nullable ? null : NO_VALUE;
}

/** @type {FieldCleaner} */
function cleanEnumField(v, { field, fs, path, push }) {
    if (fs.values.includes(v)) return v;
    if (v !== undefined) push('step.field_invalid', path, `Unknown ${field} ${JSON.stringify(v)} — set to ${JSON.stringify(fs.default)}.`);
    return fs.default;
}

/** @type {FieldCleaner} */
function cleanBooleanField(v, { field, fs, path, push }) {
    if (typeof v === 'boolean') return v;
    if (v === undefined || fs.default === undefined) return NO_VALUE;
    push('step.field_invalid', path, `${field} must be a boolean — set to ${fs.default}.`);
    return fs.default;
}

/** Range clamping is validate.js's job; a numeric string is coerced. @type {FieldCleaner} */
function cleanNumberField(v, { path, push }) {
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        push('props.coerced', path, `Coerced numeric string ${JSON.stringify(v)} to ${Number(v)}.`);
        return Number(v);
    }
    return v === undefined ? NO_VALUE : deepCopy(v);
}

/** @type {FieldCleaner} */
function cleanFormulaField(v, { path, push }) {
    if (typeof v === 'string') return truncate(v, LIMITS.MAX_FORMULA_LEN, path, push);
    return v === undefined ? NO_VALUE : deepCopy(v);
}

/**
 * One cleaner per STEP_SPECS field type. A type without an entry is left out
 * of the cleaned step.
 * @type {Record<string, FieldCleaner>}
 */
const FIELD_CLEANERS = {
    string: cleanStringField,
    url: cleanStringField,
    enum: cleanEnumField,
    boolean: cleanBooleanField,
    int: cleanNumberField,
    number: cleanNumberField,
    formula: cleanFormulaField,
    aiChecks: whenKept((v, { path, push }) => cleanAiChecks(v, path, push)),
    binding: whenPresent((v, { path, push }) => cleanBinding(v, path, push)),
    // Read even when absent: the filter is scoped to the step's own tableId.
    recordFilter: (v, { raw, path, push }) => {
        const f = cleanRecordFilter(v, path, push, { tableId: raw.tableId });
        return f === undefined ? NO_VALUE : f;
    },
    inputMapping: whenKept((v, { path, push }) => cleanInputMapping(v, path, push)),
    recordValues: whenPresent((v, { path, push }) => cleanRecordValues(v, path, push)),
    steps: whenPresent((v, { path, depth, push }) => cleanSteps(v, path, depth + 1, push)),
    switchCases: whenPresent((v, { path, depth, push }) => cleanSwitchCases(v, path, depth + 1, push)),
    stepBranches: whenPresent((v, { path, depth, push }) => cleanStepBranches(v, path, depth + 1, push)),
    navParams: whenKept((v, { path, push }) => cleanNavParams(v, path, push)),
    stringList: whenPresent((v) => cleanStringList(v)),
    aiSchema: whenPresent((v, { path, push }) => cleanAiSchema(v, path, push)),
    contextSources: whenPresent((v, { path, push }) => cleanContextSources(v, path, push)),
    aiWriteTo: whenKept((v, { path, push }) => cleanAiWriteTo(v, path, push)),
    approvalQuestions: whenPresent((v, { path, push }) => cleanApprovalQuestions(v, path, push)),
    approvalStages: whenPresent((v, { path, push }) => cleanApprovalStages(v, path, push)),
    approvalOnDecided: whenKept((v, { path, push }) => cleanApprovalOnDecided(v, path, push)),
    callParams: whenPresent((v, { path, push }) => cleanCallParams(v, path, push)),
    tierChoice: whenKept((v, { fs, path, push }) => cleanTierChoice(v, fs.maxLen || LIMITS.MAX_STRING, path, push)),
    code: (v, { field, path, push }) => {
        const c = cleanCodeField(field, v, path, push);
        return c === undefined ? NO_VALUE : c;
    },
    errorHandler: whenKept((v, { path, depth, push }) => cleanErrorHandler(v, path, depth, push)),
    retry: whenKept((v, { path, push }) => cleanRetry(v, path, push)),
};

/**
 * @param {string} path
 * @param {number} depth
 * @param {Push} push
 */
function cleanStep(raw, path, depth, push) {
    if (!isObject(raw)) {
        push('step.invalid', path, 'Each step must be an object { kind, ... } — kept for the validator.');
        return deepCopy(raw);
    }
    const spec = STEP_SPECS[raw.kind];
    if (!spec) return deepCopy(raw); // unknown kind — validate.js flags it
    if (depth >= HARD_DEPTH_CAP) {
        push('step.too_deep', path, `Step nesting exceeds the hard cap (${HARD_DEPTH_CAP}) — inner steps dropped.`);
        return { kind: raw.kind };
    }
    const out = { kind: raw.kind };
    for (const [field, fs] of Object.entries(spec.fields)) {
        const v = raw[field];
        if (v === undefined && isLateEntry(fs)) continue; // a field added after the base: only when the step carries it
        const clean = Object.hasOwn(FIELD_CLEANERS, fs.type) ? FIELD_CLEANERS[fs.type] : null;
        const value = clean ? clean(v, { raw, field, fs, path: `${path}.${field}`, depth, push }) : NO_VALUE;
        if (value !== NO_VALUE) out[field] = value;
    }
    const unknown = Object.keys(raw).filter((k) => k !== 'kind' && !(k in spec.fields));
    if (unknown.length) push('step.unknown_field', path, `Dropped unknown fields for step "${raw.kind}": ${unknown.join(', ')}. Legal: ${Object.keys(spec.fields).join(', ')}.`);
    return out;
}

const ON_ERROR_SHAPE = 'onError on a step takes { steps: [...] } (add stop: true to end the action after them); a message is a toast step inside it.';

/**
 * @param {unknown} v
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanErrorHandler(v, path, depth, push) {
    if (Array.isArray(v)) {
        if (!v.length) { push('step.on_error_invalid', path, `An empty onError list handles nothing — dropped. ${ON_ERROR_SHAPE}`); return undefined; }
        // The old array form ran its steps and then ended the action: the same as stop: true.
        push('step.on_error_legacy', path, 'onError: [...] is written as { steps: [...], stop: true } (the steps run, then the action ends).');
        return { steps: cleanSteps(v, `${path}.steps`, depth + 1, push), stop: true };
    }
    const h = /** @type {Record<string, unknown>} */ (v);
    if (!isObject(v) || !Array.isArray(h.steps)) {
        push('step.on_error_invalid', path, `${ON_ERROR_SHAPE} — dropped.`);
        return undefined;
    }
    const extra = Object.keys(v).filter((k) => k !== 'steps' && k !== 'stop');
    if (extra.length) push('step.unknown_field', path, `Dropped unknown onError fields: ${extra.join(', ')}. Legal: steps, stop.`);
    return { steps: cleanSteps(h.steps, `${path}.steps`, depth + 1, push), ...(h.stop === true ? { stop: true } : {}) };
}

/** @param {unknown} v */
const numeric = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

/**
 * @param {unknown} v
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanRetry(v, path, push) {
    const n = numeric(v);
    if (typeof n === 'number') {
        push('props.coerced', path, `retry: ${JSON.stringify(v)} is written as { times: ${n} }.`);
        return { times: n };
    }
    if (!isObject(v)) {
        push('step.field_invalid', path, 'retry takes { times: 0-3, delayMs?: 0-30000 } — dropped.');
        return undefined;
    }
    const r = /** @type {Record<string, unknown>} */ (v);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (r.times !== undefined) out.times = numeric(r.times);
    if (r.delayMs !== undefined) out.delayMs = numeric(r.delayMs);
    const extra = Object.keys(v).filter((k) => k !== 'times' && k !== 'delayMs');
    if (extra.length) push('step.unknown_field', path, `Dropped unknown retry fields: ${extra.join(', ')}. Legal: times, delayMs.`);
    return out;
}

module.exports = { cleanRecordValues, cleanSteps, cleanSwitchCases, cleanStep };

/**
 * @typedef {import('../componentSpecs/styleKnobs').PropSpec & { nullable?: boolean }} StepField
 * @typedef {Record<string, { mutatesData?: boolean, fields: Record<string, StepField> }>} StepSpecTable
 */
