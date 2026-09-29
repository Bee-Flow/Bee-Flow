/**
 * App Studio canonicalizer — sequence steps: the per-kind field walk and the
 * control-flow recursion through nested step lists and switch cases.
 */

'use strict';

const { LIMITS, STEP_SPECS } = require('../componentSpecs');
const { HARD_DEPTH_CAP, isObject, deepCopy, truncate } = require('./shared');
const { cleanBinding } = require('./bindings');
const { cleanInputMapping, cleanNavParams } = require('./mappings');
const { cleanStringList, cleanAiSchema, cleanAiWriteTo, cleanContextSources } = require('./aiFields');
const { cleanApprovalQuestions, cleanApprovalStages, cleanApprovalOnDecided } = require('./approvals');

// ---------------------------------------------------------------------------
// v2 action sequences — a { kind:'sequence', steps:[Step] } action. Each Step
// is cleaned against STEP_SPECS; control-flow steps (condition/loop/switch)
// recurse. `depth` is the nesting used by the HARD_DEPTH_CAP guard only —
// validate.js enforces MAX_ACTION_DEPTH properly.
// ---------------------------------------------------------------------------

function cleanRecordValues(raw, path, push) {
    if (!isObject(raw)) {
        push('step.field_invalid', path, 'values must be an object map of { column: binding } — reset to {}.');
        return {};
    }
    const out = {};
    for (const [col, v] of Object.entries(raw)) out[col] = cleanBinding(v, `${path}.${col}`, push);
    return out;
}

function cleanSteps(raw, path, depth, push) {
    if (!Array.isArray(raw)) {
        push('steps.invalid', path, 'steps must be an array — reset to [].');
        return [];
    }
    return raw.map((s, i) => cleanStep(s, `${path}[${i}]`, depth, push));
}

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
        } else if (fs.type === 'int') {
            if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { push('props.coerced', p, `Coerced numeric string ${JSON.stringify(v)} to ${Number(v)}.`); out[field] = Number(v); }
            else if (v !== undefined) out[field] = deepCopy(v); // range clamp is validate.js's job
        } else if (fs.type === 'formula') {
            if (typeof v === 'string') out[field] = truncate(v, LIMITS.MAX_FORMULA_LEN, p, push);
            else if (v !== undefined) out[field] = deepCopy(v);
        } else if (fs.type === 'binding') {
            if (v !== undefined) out[field] = cleanBinding(v, p, push);
        } else if (fs.type === 'inputMapping') {
            if (v !== undefined) { const m = cleanInputMapping(v, p, push); if (m !== undefined) out[field] = m; }
        } else if (fs.type === 'recordValues') {
            if (v !== undefined) out[field] = cleanRecordValues(v, p, push);
        } else if (fs.type === 'steps') {
            if (v !== undefined) out[field] = cleanSteps(v, p, depth + 1, push);
        } else if (fs.type === 'switchCases') {
            if (v !== undefined) out[field] = cleanSwitchCases(v, p, depth + 1, push);
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
        }
    }
    const unknown = Object.keys(raw).filter((k) => k !== 'kind' && !(k in spec.fields));
    if (unknown.length) push('step.unknown_field', path, `Dropped unknown fields for step "${raw.kind}": ${unknown.join(', ')}. Legal: ${Object.keys(spec.fields).join(', ')}.`);
    return out;
}

module.exports = { cleanRecordValues, cleanSteps, cleanSwitchCases, cleanStep };
