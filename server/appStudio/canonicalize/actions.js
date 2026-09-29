/**
 * App Studio canonicalizer — an action, cleaned against its ACTION_SPECS entry.
 */

'use strict';

const { LIMITS, ACTION_SPECS } = require('../componentSpecs');
const { deepCopy, truncate } = require('./shared');
const { cleanBinding } = require('./bindings');
const { cleanInputMapping, cleanEffects, cleanNavParams } = require('./mappings');
const { cleanStringList, cleanAiSchema, cleanAiWriteTo } = require('./aiFields');
const { cleanRecordValues, cleanSteps } = require('./steps');

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function canonAction(raw, path, push) {
    const spec = ACTION_SPECS[raw.kind];
    if (!spec) {
        // Unknown kind — validate.js flags it with a closest-match hint.
        return deepCopy(raw);
    }
    const out = { kind: raw.kind };
    for (const [field, fs] of Object.entries(spec.fields)) {
        const p = `${path}.${field}`;
        const v = raw[field];
        if (fs.type === 'steps') {
            out[field] = cleanSteps(v, p, 0, push);
            continue;
        }
        if (fs.type === 'string' || fs.type === 'url') {
            if (typeof v === 'string') out[field] = truncate(v, fs.maxLen || LIMITS.MAX_STRING, p, push);
            else if (v === null && fs.nullable) out[field] = null;
            else if (v === undefined) { if (fs.nullable) out[field] = null; } // absent required-nullable → null (templates ship null)
            else {
                push('action.field_invalid', p, `${field} must be a string${fs.nullable ? ' or null' : ''} — dropped.`);
                if (fs.nullable) out[field] = null;
            }
        } else if (fs.type === 'enum') {
            if (fs.values.includes(v)) out[field] = v;
            else {
                out[field] = fs.default;
                if (v !== undefined) push('action.tone_invalid', p, `Unknown ${field} ${JSON.stringify(v)} — set to ${JSON.stringify(fs.default)}. Legal: ${fs.values.join(', ')}.`);
            }
        } else if (fs.type === 'boolean') {
            if (typeof v === 'boolean') out[field] = v;
            else {
                out[field] = fs.default;
                if (v !== undefined) push('action.field_invalid', p, `${field} must be a boolean — set to ${fs.default}.`);
            }
        } else if (fs.type === 'inputMapping') {
            if (v !== undefined) {
                const mapping = cleanInputMapping(v, p, push);
                if (mapping !== undefined) out[field] = mapping;
            }
        } else if (fs.type === 'effects') {
            if (v !== undefined) {
                const effects = cleanEffects(v, p, push);
                if (effects !== undefined) out[field] = effects;
            }
        } else if (fs.type === 'navParams') {
            if (v !== undefined) {
                const params = cleanNavParams(v, p, push);
                if (params !== undefined) out[field] = params;
            }
        } else if (fs.type === 'stringList') {
            if (v !== undefined) out[field] = cleanStringList(v);
        } else if (fs.type === 'aiSchema') {
            if (v !== undefined) out[field] = cleanAiSchema(v, p, push);
        } else if (fs.type === 'aiWriteTo') {
            if (v !== undefined) { const w = cleanAiWriteTo(v, p, push); if (w !== undefined) out[field] = w; }
        } else if (fs.type === 'recordValues') {
            // create_record's column map. Without this branch the field is not
            // in `out` at all, so every save of a bare create_record action
            // threw the author's column values away — no error, no warning, an
            // action that inserts an empty row. cleanStep has always had it;
            // canonAction is the copy that did not.
            if (v !== undefined) out[field] = cleanRecordValues(v, p, push);
        } else if (fs.type === 'binding') {
            // ai_extract.source / ai_generate.attachments / kb_query.query — the
            // first actions to carry a binding. Same treatment as in cleanStep.
            if (v !== undefined) out[field] = cleanBinding(v, p, push);
        } else if (fs.type === 'int') {
            if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
                push('props.coerced', p, `Coerced numeric string ${JSON.stringify(v)} to ${Number(v)}.`);
                out[field] = Number(v);
            } else if (v !== undefined) out[field] = deepCopy(v); // range clamp is validate.js's job
        } else if (v !== undefined) {
            // THE CLASS, not another instance. This chain is a list of known
            // field types, and until now anything missing from it fell off the
            // end: the field never reached `out`, so a save silently threw the
            // author's value away with no error and no repair note. That is how
            // `recordValues` — the branch right above — went unnoticed, and a
            // new field type in ACTION_SPECS would have done it again.
            //
            // Keeping the value is the conservative half: canonicalize is a
            // cleanup pass, not a gate (the `int` branch says as much — range
            // checking is validate.js's job), so passing it through unchanged
            // leaves the author exactly where they were. The note is the other
            // half: it makes the gap visible in the repair log instead of
            // letting it be data loss nobody reports.
            out[field] = deepCopy(v);
            push('action.field_uncanonicalised', p,
                `No canonicalisation rule for field type "${fs.type}" (${field}) — kept as-is. Add a branch in canonAction.`);
        }
    }
    const unknown = Object.keys(raw).filter((k) => k !== 'kind' && !(k in spec.fields));
    if (unknown.length) {
        push('action.unknown_field', path, `Dropped unknown fields for kind "${raw.kind}": ${unknown.join(', ')}. Legal: ${Object.keys(spec.fields).join(', ')}.`);
    }
    return out;
}

module.exports = { canonAction };
