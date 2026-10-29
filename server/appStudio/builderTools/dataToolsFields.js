// @typecheck strict
/**
 * The field half of app_upsert_table: one authored field spec read, checked
 * and turned into the stored field, inheriting from the field it evolves.
 * Pure: nothing here touches its inputs or the data model.
 */

'use strict';

const { FIELD_TYPES, SYSTEM_COLUMNS, KEY_RE: DATA_KEY_RE, newFieldId } = require('../dataModel');
const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');
const { pickClosestId, tableIdHint } = require('./dataToolsShared');

/**
 * A field's `default` as the column will hold it, or an error.
 *
 * The tool schema types `default` as a string — the one shape every
 * provider's template renders cleanly (since 2026-09-17; untyped before), so
 * a model that follows it writes "false" on a bool and "0" on a number. The
 * DDL reads a bool default by truthiness (`value ? TRUE : FALSE`), and the
 * string "false" is truthy: `default:"false"` on a bool became `DEFAULT
 * TRUE`, the opposite of what was asked, silently (caught in review
 * 2026-09-18). So the value is read by the field's type here, once, and one
 * that cannot be read is refused rather than stored. Dates and text keep
 * the string as written.
 */
/**
 * @param {unknown} value
 * @param {string} type  the field's type
 * @param {string} at  the field's path in the call
 * @returns {{ value?: unknown, error?: string }}
 */
function coerceFieldDefault(value, type, at) {
    if (value === null || value === undefined) return { value };
    if (type === 'bool') {
        if (typeof value === 'boolean') return { value };
        const s = String(value).trim().toLowerCase();
        if (s === 'true' || s === '1') return { value: true };
        if (s === 'false' || s === '0' || s === '') return { value: false };
        return { error: `${at}.default ${JSON.stringify(value)} is not a boolean — a bool field's default is "true" or "false".` };
    }
    if (type === 'number') {
        const n = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(String(value).trim()));
        if (!Number.isFinite(n)) return { error: `${at}.default ${JSON.stringify(value)} is not a number — a number field's default is a numeric literal such as "0".` };
        return { value: n };
    }
    return { value };
}

/**
 * One authored field spec with the tolerated spellings read: `label` is what a
 * form-minded model calls `name`, and a field with a name but no key gets the
 * slug of its name (unique within this call, recorded in derivedFieldKeys). An
 * explicit key always wins. Never touches the input.
 * @param {FieldSpec} given
 * @param {number} i  the field's position in the call
 * @param {Set<string>} seenKeys  the keys of the fields before it
 * @param {string[]} derivedFieldKeys
 * @returns {FieldSpec}
 */
function normaliseFieldSpec(given, i, seenKeys, derivedFieldKeys) {
    const raw = { ...given };
    if (raw.name === undefined && typeof raw.label === 'string') { raw.name = raw.label; delete raw.label; }
    if ((raw.key === undefined || raw.key === null) && typeof raw.name === 'string' && raw.name.trim()) {
        raw.key = keyFromTitle(raw.name, i, new Set([...seenKeys, ...SYSTEM_COLUMNS]));
        derivedFieldKeys.push(`${JSON.stringify(raw.name)} → ${raw.key}`);
    }
    return raw;
}

/**
 * A field spec whose key and type can stand, or the error for one that cannot;
 * a usable key is added to seenKeys.
 * @param {FieldSpec} raw
 * @param {string} at  the field's path in the call, e.g. "fields[2]"
 * @param {Set<string>} seenKeys
 * @returns {{ spec?: CheckedFieldSpec, error?: string, _fixHint?: string }}
 */
function checkFieldSpec(raw, at, seenKeys) {
    if (typeof raw.key !== 'string' || !DATA_KEY_RE.test(raw.key)) {
        return { error: `${at}.key ${JSON.stringify(raw.key)} must be lowercase snake_case starting with a letter (max 63 chars).` };
    }
    if (SYSTEM_COLUMNS.includes(raw.key)) {
        return {
            error: `${at}.key "${raw.key}" collides with a reserved system column (${SYSTEM_COLUMNS.join(', ')}).`,
            _fixHint: 'System columns exist on every table automatically — bind to them, never declare them.',
        };
    }
    if (seenKeys.has(raw.key)) return { error: `${at}.key "${raw.key}" is duplicated in this call.` };
    seenKeys.add(raw.key);
    // The authored type is whatever the caller sent; FIELD_TYPES decides.
    const type = /** @type {string} */ (raw.type);
    if (!FIELD_TYPES.includes(type)) {
        const suggestion = pickClosestId(type, FIELD_TYPES);
        return { error: `${at}.type ${JSON.stringify(raw.type)} is not a field type.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Legal types: ${FIELD_TYPES.join(', ')}.` };
    }
    return { spec: /** @type {CheckedFieldSpec} */ (raw) };
}

/**
 * The existing field a spec evolves: the one its fieldId names (an unknown id
 * is an error), else the one with the same key (stable id — no drop+add), else
 * none.
 * @param {CheckedFieldSpec} raw
 * @param {string} at
 * @param {{ byId: Map<string, DataField>, byKey: Map<string, DataField>, oldFields: DataField[], tableId: string }} table
 * @returns {{ old?: DataField|null, error?: string, _fixHint?: string }}  the old field, or the error
 */
function priorField(raw, at, { byId, byKey, oldFields, tableId }) {
    if (raw.fieldId !== undefined && raw.fieldId !== null) {
        const old = byId.get(raw.fieldId) || null;
        if (!old) {
            return {
                error: `${at}.fieldId ${JSON.stringify(raw.fieldId)} does not exist on ${tableId}.`,
                _fixHint: `Field ids on the table: ${oldFields.map((f) => f.id).join(', ') || '(none)'} — omit fieldId for a new field.`,
            };
        }
        return { old };
    }
    return { old: byKey.get(raw.key) || null };
}

/**
 * The stored field for a checked spec: what the spec says, and for everything
 * it leaves out what the existing field already was.
 * @param {CheckedFieldSpec} raw
 * @param {DataField|null} old
 * @param {string} at
 * @param {DataModel} model
 * @returns {{ field?: DataField, error?: string, _fixHint?: string }}  the field, or the error
 */
function buildField(raw, old, at, model) {
    /** @type {DataField} */
    const field = {
        id: old ? old.id : newFieldId(),
        key: raw.key,
        name: (typeof raw.name === 'string' && raw.name) ? raw.name : (old ? old.name : raw.key),
        type: raw.type,
        required: raw.required === true,
        unique: raw.unique === true,
    };
    if (raw.subtype !== undefined) field.subtype = raw.subtype;
    else if (old && old.subtype !== undefined) field.subtype = old.subtype;
    if (raw.default !== undefined) {
        const coerced = coerceFieldDefault(raw.default, raw.type, at);
        if (coerced.error) return { error: coerced.error };
        field.default = coerced.value;
    } else if (old && old.default !== undefined) {
        field.default = old.default;
    }
    const typed = applyTypedProps(field, raw, old, at, model);
    if (typed) return typed;
    return { field };
}

/**
 * The per-type part of a field (select options, relation target, computed
 * expression), written onto it in place; the error when the spec lacks it.
 * @param {DataField} field
 * @param {CheckedFieldSpec} raw
 * @param {DataField|null} old
 * @param {string} at
 * @param {DataModel} model
 * @returns {{ error: string, _fixHint?: string } | null}
 */
function applyTypedProps(field, raw, old, at, model) {
    if (raw.type === 'select' || raw.type === 'multiselect') return applySelectOptions(field, raw, old, at);
    if (raw.type === 'relation') return applyRelation(field, raw, old, at, model);
    if (raw.type === 'computed') return applyComputed(field, raw, old, at);
    return null;
}

/**
 * A select field's options: the spec's, else the existing field's; none is an error.
 * @param {DataField} field  written in place
 * @param {CheckedFieldSpec} raw
 * @param {DataField|null} old
 * @param {string} at
 * @returns {{ error: string } | null}
 */
function applySelectOptions(field, raw, old, at) {
    const options = Array.isArray(raw.options) ? raw.options
        : (old && Array.isArray(old.options) ? old.options : []);
    if (!options.length) return { error: `${at} (${raw.type}) requires a non-empty options array (strings or {value,label}).` };
    field.options = options;
    return null;
}

/**
 * A relation field's target table and display field: the spec's, else the
 * existing field's; a missing target is an error.
 * @param {DataField} field  written in place
 * @param {CheckedFieldSpec} raw
 * @param {DataField|null} old
 * @param {string} at
 * @param {DataModel} model
 * @returns {{ error: string, _fixHint: string } | null}
 */
function applyRelation(field, raw, old, at, model) {
    const rel = (raw.relation && typeof raw.relation === 'object') ? raw.relation : null;
    const target = rel ? (rel.tableId || rel.table) : (old && old.relation ? old.relation.table : null);
    if (typeof target !== 'string' || !target) {
        return { error: `${at} (relation) requires relation: { tableId } — the tbl_… id of the table it points at.`, _fixHint: tableIdHint(model) };
    }
    field.relation = { table: target };
    const display = rel ? (rel.displayFieldKey || rel.displayField) : (old && old.relation ? old.relation.displayField : null);
    if (typeof display === 'string' && display) field.relation.displayField = display;
    return null;
}

/**
 * A computed field's expression, result type and storage; a missing expression
 * is an error.
 * @param {DataField} field  written in place
 * @param {CheckedFieldSpec} raw
 * @param {DataField|null} old
 * @param {string} at
 * @returns {{ error: string } | null}
 */
function applyComputed(field, raw, old, at) {
    const comp = (raw.computed && typeof raw.computed === 'object') ? raw.computed : (old ? old.computed : null);
    if (!comp || typeof comp.expr !== 'string' || !comp.expr.trim()) {
        return { error: `${at} (computed) requires computed: { expr, type? }.` };
    }
    // `stored` decides whether this is a real column (filterable,
    // sortable, aggregatable) or a read-time expression, and it used
    // to be dropped here — rebuilt from expr and type alone. Two ways
    // that bit: a stored column could not be authored through this
    // tool at all, and re-sending an existing table (to edit some
    // OTHER field) silently DOWNGRADED one to read-time. Every filter
    // and aggregate on it then failed with "is a read-time computed
    // field and cannot be queried", from a call that never mentioned
    // it. So: an explicit value wins, otherwise inherit what the field
    // already was — a caller who says nothing changes nothing.
    const stored = typeof comp.stored === 'boolean'
        ? comp.stored
        : Boolean(old && old.computed && old.computed.stored);
    field.computed = { expr: comp.expr, ...(comp.type ? { type: comp.type } : {}), ...(stored ? { stored: true } : {}) };
    return null;
}

/**
 * @typedef {import('./dataTools').DataField} DataField
 * @typedef {import('./dataTools').DataModel} DataModel
 * @typedef {{
 *   key?: string, name?: unknown, label?: unknown, type?: string, fieldId?: string, required?: unknown, unique?: unknown,
 *   subtype?: string, default?: unknown, options?: unknown,
 *   relation?: { tableId?: string, table?: string, displayFieldKey?: string, displayField?: string },
 *   computed?: { expr?: unknown, type?: string, stored?: unknown },
 * }} FieldSpec  one entry of app_upsert_table's fields[] as authored
 * @typedef {FieldSpec & { key: string, type: string }} CheckedFieldSpec  a spec past checkFieldSpec: a valid key and type
 */

module.exports = { coerceFieldDefault, normaliseFieldSpec, checkFieldSpec, priorField, buildField };
