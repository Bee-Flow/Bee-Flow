// @typecheck
/**
 * App Studio canonicalizer — the native AI field cleaners: string lists, the
 * extraction schema, and the writeTo block that lands extracted rows.
 */

'use strict';

const { isObject, truncate, deepCopy } = require('./shared');
const { LIMITS } = require('../componentSpecs/limits');
const { cleanBinding, cleanRecordFilter } = require('./bindings');

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
    cleanUpsertKey(v, out, path, push);
    if (v.replaceWhere !== undefined && v.replaceWhere !== null) {
        const r = cleanRecordFilter(v.replaceWhere, `${path}.replaceWhere`, push, { tableId: out.tableId });
        if (r !== undefined) out.replaceWhere = r;
    }
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
 * writeTo.upsertKey (package 5): a list of 1..5 distinct column keys. A bare string becomes a
 * one-column list; an upsertOn that is part of the key is folded into it. Absent stays absent.
 * @param {Record<string, any>} v
 * @param {Record<string, any>} out
 * @param {string} path
 * @param {(arg0: string, arg1: string, arg2: string) => void} push
 */
function cleanUpsertKey(v, out, path, push) {
    if (v.upsertKey === undefined || v.upsertKey === null) return;
    let raw = v.upsertKey;
    if (typeof raw === 'string') {
        push('writeto.upsert_key_coerced', `${path}.upsertKey`, 'upsertKey is a list of columns: wrapped the single column in a list.');
        raw = [raw];
    }
    if (!Array.isArray(raw)) { out.upsertKey = deepCopy(raw); return; } // wrong type left for validate.js
    const cols = [...new Set(raw.filter((c) => typeof c === 'string' && c))];
    if (cols.length > LIMITS.MAX_UPSERT_KEY_COLUMNS) {
        push('writeto.upsert_key_cut', `${path}.upsertKey`, `upsertKey takes at most ${LIMITS.MAX_UPSERT_KEY_COLUMNS} columns: kept the first ${LIMITS.MAX_UPSERT_KEY_COLUMNS}.`);
    }
    const key = cols.slice(0, LIMITS.MAX_UPSERT_KEY_COLUMNS);
    if (!key.length) return;
    out.upsertKey = key;
    if (typeof out.upsertOn === 'string' && key.includes(out.upsertOn)) {
        delete out.upsertOn;
        push('writeto.upsert_on_folded', `${path}.upsertOn`, 'upsertOn is part of upsertKey: dropped upsertOn.');
    }
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

/**
 * modelTier: a tier name (truncated like any string field), or a binding worked
 * out per run ({kind:'formula',expr} / {kind:'static',value}), rebuilt to its
 * exact shape. Anything else is dropped with a note (as the string field did).
 * A definition that writes a plain tier name canonicalizes byte-identically.
 * @param {number} maxLen
 * @param {string} path
 * @param {(code: string, path: string, message: string) => void} push
 * @param {string} [code]
 */
function cleanTierChoice(v, maxLen, path, push, code = 'step.field_invalid') {
    if (typeof v === 'string') return truncate(v, maxLen, path, push);
    if (isObject(v) && v.kind === 'formula') {
        return { kind: 'formula', expr: typeof v.expr === 'string' ? truncate(v.expr, LIMITS.MAX_FORMULA_LEN, `${path}.expr`, push) : deepCopy(v.expr) };
    }
    if (isObject(v) && v.kind === 'static') return { kind: 'static', value: deepCopy(v.value) };
    push(code, path, 'modelTier must be a tier name or {kind:"formula",expr} — dropped.');
    return undefined;
}

module.exports = { cleanStringList, cleanAiSchema, cleanAiWriteTo, cleanContextSources, cleanTierChoice };
