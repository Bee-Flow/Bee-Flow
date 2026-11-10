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
        out.steps = cleanSteps(c.steps, `${cp}.steps`, depth, push);
        return out;
    });
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

/**
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
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
        const p = `${path}.${field}`;
        const v = raw[field];
        if (v === undefined && isLateEntry(fs)) continue; // a field added after the base: only when the step carries it
        if (fs.type === 'string' || fs.type === 'url') {
            if (typeof v === 'string') out[field] = truncate(v, fs.maxLen || LIMITS.MAX_STRING, p, push);
            else if (v === null && fs.nullable) out[field] = null;
            else if (v === undefined) { if (fs.nullable) out[field] = null; }
            else { push('step.field_invalid', p, `${field} must be a string${fs.nullable ? ' or null' : ''} — dropped.`); if (fs.nullable) out[field] = null; }
        } else if (fs.type === 'enum') {
            if (fs.values.includes(v)) out[field] = v;
            else { out[field] = fs.default; if (v !== undefined) push('step.field_invalid', p, `Unknown ${field} ${JSON.stringify(v)} — set to ${JSON.stringify(fs.default)}.`); }
        } else if (fs.type === 'boolean') {
            if (typeof v === 'boolean') out[field] = v;
            else if (v !== undefined && fs.default !== undefined) { out[field] = fs.default; push('step.field_invalid', p, `${field} must be a boolean — set to ${fs.default}.`); }
        } else if (fs.type === 'int' || fs.type === 'number') {
            if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { push('props.coerced', p, `Coerced numeric string ${JSON.stringify(v)} to ${Number(v)}.`); out[field] = Number(v); }
            else if (v !== undefined) out[field] = deepCopy(v); // range clamp is validate.js's job
        } else if (fs.type === 'aiChecks') {
            if (v !== undefined) { const c = cleanAiChecks(v, p, push); if (c !== undefined) out[field] = c; }
        } else if (fs.type === 'formula') {
            if (typeof v === 'string') out[field] = truncate(v, LIMITS.MAX_FORMULA_LEN, p, push);
            else if (v !== undefined) out[field] = deepCopy(v);
        } else if (fs.type === 'binding') {
            if (v !== undefined) out[field] = cleanBinding(v, p, push);
        } else if (fs.type === 'recordFilter') {
            const f = cleanRecordFilter(v, p, push, { tableId: raw.tableId });
            if (f !== undefined) out[field] = f;
        } else if (fs.type === 'inputMapping') {
            if (v !== undefined) { const m = cleanInputMapping(v, p, push); if (m !== undefined) out[field] = m; }
        } else if (fs.type === 'recordValues') {
            if (v !== undefined) out[field] = cleanRecordValues(v, p, push);
        } else if (fs.type === 'steps') {
            if (v !== undefined) out[field] = cleanSteps(v, p, depth + 1, push);
        } else if (fs.type === 'switchCases') {
            if (v !== undefined) out[field] = cleanSwitchCases(v, p, depth + 1, push);
        } else if (fs.type === 'stepBranches') {
            if (v !== undefined) out[field] = cleanStepBranches(v, p, depth + 1, push);
        } else if (fs.type === 'navParams') {
            if (v !== undefined) { const m = cleanNavParams(v, p, push); if (m !== undefined) out[field] = m; }
        } else if (fs.type === 'stringList') {
            if (v !== undefined) out[field] = cleanStringList(v);
        } else if (fs.type === 'aiSchema') {
            if (v !== undefined) out[field] = cleanAiSchema(v, p, push);
        } else if (fs.type === 'contextSources') {
            if (v !== undefined) out[field] = cleanContextSources(v, p, push);
        } else if (fs.type === 'aiWriteTo') {
            if (v !== undefined) { const w = cleanAiWriteTo(v, p, push); if (w !== undefined) out[field] = w; }
        } else if (fs.type === 'approvalQuestions') {
            if (v !== undefined) out[field] = cleanApprovalQuestions(v, p, push);
        } else if (fs.type === 'approvalStages') {
            if (v !== undefined) out[field] = cleanApprovalStages(v, p, push);
        } else if (fs.type === 'approvalOnDecided') {
            if (v !== undefined) { const w = cleanApprovalOnDecided(v, p, push); if (w !== undefined) out[field] = w; }
        } else if (fs.type === 'callParams') {
            if (v !== undefined) out[field] = cleanCallParams(v, p, push);
        } else if (fs.type === 'tierChoice') {
            if (v !== undefined) { const t = cleanTierChoice(v, fs.maxLen || LIMITS.MAX_STRING, p, push); if (t !== undefined) out[field] = t; }
        } else if (fs.type === 'code') {
            // Source text, kept whole: a cut would leave broken code; validate refuses past maxLen.
            if (typeof v === 'string') out[field] = v;
            else if (v !== undefined) push('step.field_invalid', p, `${field} must be a string of JavaScript — dropped.`);
        } else if (fs.type === 'errorHandler' || fs.type === 'retry') {
            if (v !== undefined) { const e = cleanEnvelopeField(fs.type, v, p, depth, push); if (e !== undefined) out[field] = e; }
        }
    }
    const unknown = Object.keys(raw).filter((k) => k !== 'kind' && !(k in spec.fields));
    if (unknown.length) push('step.unknown_field', path, `Dropped unknown fields for step "${raw.kind}": ${unknown.join(', ')}. Legal: ${Object.keys(spec.fields).join(', ')}.`);
    return out;
}

/**
 * The error-handling envelope of a server step: `onError` (handler) and `retry`.
 * undefined = drop the field (with a note).
 *
 * @param {string} type
 * @param {unknown} v
 * @param {string} path
 * @param {number} depth
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanEnvelopeField(type, v, path, depth, push) {
    return type === 'retry' ? cleanRetry(v, path, push) : cleanErrorHandler(v, path, depth, push);
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
