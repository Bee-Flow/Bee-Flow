// @typecheck
/**
 * App Studio canonicalizer — the native AI field cleaners: string lists, the
 * extraction schema, and the writeTo block that lands extracted rows.
 */

'use strict';

const { isObject, truncate } = require('./shared');
const { LIMITS } = require('../componentSpecs/limits');
const { cleanBinding } = require('./bindings');

// ── Native AI field cleaners (shared by cleanStep + canonAction) ─────────────
const AI_SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'date', 'array', 'object']);

function cleanStringList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === 'string' && x).slice(0, 50);
}

/**
 * @param {string} path
 * @param {((arg0: string, arg1: string, arg2: string) => void) | undefined} push
 */
function cleanAiSchema(v, path, push) {
    if (!Array.isArray(v)) return [];
    const out = [];
    const seen = new Set();
    for (const f of v) {
        if (!isObject(f) || typeof f.name !== 'string' || !f.name || seen.has(f.name)) continue;
        seen.add(f.name);
        if (out.length >= LIMITS.MAX_AI_SCHEMA_FIELDS) {
            if (typeof push === 'function') {
                push('ai_schema.fields_truncated', path || 'schema',
                    `Schema has more than ${LIMITS.MAX_AI_SCHEMA_FIELDS} fields — the maximum is ${LIMITS.MAX_AI_SCHEMA_FIELDS}; the rest were dropped, starting at "${f.name}".`);
            }
            break;
        }
        const field = { name: f.name, type: AI_SCHEMA_TYPES.has(f.type) ? f.type : 'string' };
        const description = cleanSchemaDescription(f, path, push);
        if (description) field.description = description;
        if (f.required === true) field.required = true;
        out.push(field);
    }
    return out;
}

/**
 * NEVER silent: the description IS the extraction rulebook (ai_extract has no prompt field), so a cut
 * here removes instructions mid-sentence while every test on the raw template keeps passing. The repair
 * record is what lets a pin catch an overrun before install.
 * @param {{ name: string, description?: unknown }} f
 * @param {string} path
 * @param {((arg0: string, arg1: string, arg2: string) => void) | undefined} push
 */
function cleanSchemaDescription(f, path, push) {
    if (typeof f.description !== 'string' || !f.description) return '';
    if (f.description.length > LIMITS.MAX_AI_SCHEMA_FIELD_DESC && typeof push === 'function') {
        push('ai_schema.description_truncated', `${path || 'schema'}.${f.name}`,
            `Schema field "${f.name}" description is ${f.description.length} chars — the maximum is ${LIMITS.MAX_AI_SCHEMA_FIELD_DESC}; truncated. The cut text is NOT seen by the model.`);
    }
    return f.description.slice(0, LIMITS.MAX_AI_SCHEMA_FIELD_DESC);
}

/**
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanAiWriteTo(v, path, push) {
    if (!isObject(v)) return undefined;
    const out = {};
    if (typeof v.tableId === 'string' && v.tableId) out.tableId = v.tableId;
    /** @type {Record<string, string>} */
    const mapping = {};
    if (isObject(v.mapping)) {
        for (const [col, field] of Object.entries(v.mapping)) {
            if (typeof col === 'string' && typeof field === 'string' && field) mapping[col] = field;
        }
    }
    out.mapping = mapping;
    // The column that says which row an extracted row IS. Kept only when
    // present, so definitions that always insert stay byte-identical.
    if (typeof v.upsertOn === 'string' && v.upsertOn) out.upsertOn = v.upsertOn;
    // Both only mean anything alongside upsertOn, and both are kept only when
    // explicitly set — so every existing definition stays byte-identical.
    //   insertMissing:false — a key that matches nothing is a MISMATCH to
    //     report, not a new row to invent.
    //   fillOnly:true       — write only into columns that are still empty, so
    //     a blank answer never erases a person's correction or a default.
    if (v.insertMissing === false) out.insertMissing = false;
    if (v.fillOnly === true) out.fillOnly = true;
    // Provenance columns stamped on every extracted row. Only kept when there is
    // something to keep, so an absent `constants` stays absent rather than
    // padding every existing definition with an empty object.
    if (isObject(v.constants)) {
        const constants = {};
        let n = 0;
        for (const [col, binding] of Object.entries(v.constants)) {
            if (typeof col !== 'string' || !col || n >= 10) continue;
            const b = cleanBinding(binding, `${path}.constants.${col}`, push);
            if (b === undefined) continue;
            constants[col] = b;
            n += 1;
        }
        if (n) out.constants = constants;
    }
    return out;
}


/**
 * `contextSources` — extra LABELLED context an AI step may read.
 *
 * A step gets one promptContext, so it could be shown the conversation or the
 * order lines, never both. Each entry here is {label, source}; the label rides
 * into the prompt so the model reads named tables rather than two anonymous
 * arrays. Entries without a usable source are dropped: a label alone would
 * announce a table that is not there.
 */
/**
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanContextSources(v, path, push) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (let i = 0; i < v.length; i += 1) {
        const entry = v[i];
        if (out.length >= LIMITS.MAX_CONTEXT_SOURCES) {
            const dropped = v.slice(i).filter((e) => isObject(e) && isObject(e.source))
                .map((e) => (typeof e.label === 'string' && e.label.trim() ? JSON.stringify(e.label.trim()) : '(no label)'));
            if (dropped.length) {
                push('step.context_sources_truncated', path,
                    `${v.length} context sources — the maximum is ${LIMITS.MAX_CONTEXT_SOURCES}; dropped: ${dropped.join(', ')}.`);
            }
            break;
        }
        if (!isObject(entry)) continue;
        // cleanBinding answers a static-null binding for anything it cannot
        // read, so an entry that never named a source would survive as an empty
        // one — a label in the prompt with nothing under it. Check the input,
        // not the cleaned result.
        if (!isObject(entry.source)) continue;
        const source = cleanBinding(entry.source, `${path}.source`, push);
        if (source === undefined || source === null) continue;
        const item = { source };
        if (typeof entry.label === 'string' && entry.label.trim()) {
            item.label = truncate(entry.label.trim(), LIMITS.MAX_CONTEXT_SOURCE_LABEL, `${path}[${out.length}].label`, push);
        }
        out.push(item);
    }
    return out;
}

module.exports = { cleanStringList, cleanAiSchema, cleanAiWriteTo, cleanContextSources };
