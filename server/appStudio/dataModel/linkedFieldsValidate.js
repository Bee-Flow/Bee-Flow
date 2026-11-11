// @typecheck strict
/**
 * App Studio data model — the checks for lookup and rollup fields, the many relation, a
 * relation's onDelete rule and a table's declared indexes (core/dataEngine/dataModel/linkedFields.js).
 * Called by validateDataModel after the per-field checks; silent for a model that uses none of
 * them, so every existing model validates exactly as before.
 *
 * All of them belong to tables with their own storage: a linked Studio table has no junction,
 * no index of this app and no rows this app's delete walks.
 */

'use strict';

const { SYSTEM_COLUMNS, FILTER_OPS } = require('./vocabulary');
const {
    ROLLUP_FNS, ON_DELETE_RULES, LINKED_FIELD_LIMITS, isManyRelation, isColumnlessLinkField,
} = require('../../core/dataEngine/dataModel/linkedFields');

/**
 * @typedef {{ id?: unknown, key?: unknown, type?: unknown, required?: unknown, unique?: unknown, relation?: unknown,
 *   lookup?: unknown, rollup?: unknown, computed?: unknown }} VField
 * @typedef {{ id?: unknown, key?: unknown, source?: unknown, fields?: unknown, indexes?: unknown }} VTable
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);
/** @param {VTable | undefined} t */
const ownStorage = (t) => !!t && (t.source === undefined || t.source === null);
/** @param {VTable} t @returns {VField[]} */
const fieldsOf = (t) => (Array.isArray(t.fields) ? t.fields.filter(isObj) : []);

/**
 * @param {VTable[]} tables
 * @param {unknown} ref  a table id or key
 */
function tableBy(tables, ref) {
    return typeof ref === 'string' ? tables.find((t) => t.id === ref || t.key === ref) : undefined;
}

/**
 * A field that has a column a lookup may show, a rollup may sum or an index may name.
 * @param {VField | undefined} f
 */
function hasColumn(f) {
    if (!f || isColumnlessLinkField(f)) return false;
    return f.type !== 'computed' || (isObj(f.computed) && f.computed.stored === true);
}

/** @param {VField | undefined} f */
const isSingleRelation = (f) => !!f && f.type === 'relation' && isObj(f.relation) && !isManyRelation(f);

/**
 * @param {VField} field
 * @param {VTable} table
 * @param {VTable[]} tables
 * @param {string} fw
 * @returns {string[]}
 */
function lookupErrors(field, table, tables, fw) {
    const spec = isObj(field.lookup) ? field.lookup : null;
    if (!spec || !str(spec.relation) || !str(spec.field)) return [`${fw} (lookup) requires lookup { relation, field }`];
    const rel = fieldsOf(table).find((f) => f.key === spec.relation);
    if (!isSingleRelation(rel)) return [`${fw}.lookup.relation "${spec.relation}" must be a single relation field of the same table`];
    const target = tableBy(tables, /** @type {{ table?: unknown }} */ (/** @type {VField} */ (rel).relation).table);
    if (!target || !ownStorage(target)) return [`${fw}.lookup.relation "${spec.relation}" must point at a table of this app with its own rows`];
    const name = /** @type {string} */ (spec.field);
    if (SYSTEM_COLUMNS.includes(name)) return [];
    if (!hasColumn(fieldsOf(target).find((f) => f.key === name))) {
        return [`${fw}.lookup.field "${name}" must be a stored field of "${target.key}" (not a lookup, rollup, many relation or read-time computed field)`];
    }
    return [];
}

/**
 * The clauses a rollup keeps its child rows with: plain { field, op, value } on the child.
 * @param {unknown} filter
 * @param {VTable} child
 * @param {string} fw
 * @returns {string[]}
 */
function rollupFilterErrors(filter, child, fw) {
    if (filter === undefined || filter === null) return [];
    const max = LINKED_FIELD_LIMITS.MAX_ROLLUP_FILTERS;
    if (!Array.isArray(filter) || filter.length > max) return [`${fw}.rollup.filter must be a list of at most ${max} { field, op, value } clauses`];
    /** @type {string[]} */
    const errors = [];
    for (const [i, c] of filter.entries()) {
        const at = `${fw}.rollup.filter[${i}]`;
        if (!isObj(c) || !str(c.field) || typeof c.op !== 'string' || !FILTER_OPS.includes(c.op)) {
            errors.push(`${at} must be { field, op, value } with an op of ${FILTER_OPS.join(', ')}`);
        } else if (!SYSTEM_COLUMNS.includes(/** @type {string} */ (c.field)) && !hasColumn(fieldsOf(child).find((f) => f.key === c.field))) {
            errors.push(`${at}.field "${c.field}" must be a stored field of "${child.key}"`);
        }
    }
    return errors;
}

/**
 * @param {VField} field
 * @param {VTable} table
 * @param {VTable[]} tables
 * @param {string} fw
 * @returns {string[]}
 */
function rollupErrors(field, table, tables, fw) {
    const spec = isObj(field.rollup) ? field.rollup : null;
    if (!spec) return [`${fw} (rollup) requires rollup { table, relation, fn, field?, filter? }`];
    if (typeof spec.fn !== 'string' || !ROLLUP_FNS.includes(spec.fn)) return [`${fw}.rollup.fn must be one of ${ROLLUP_FNS.join(', ')}`];
    const child = tableBy(tables, spec.table);
    if (!child || !ownStorage(child)) return [`${fw}.rollup.table "${spec.table}" must be a table of this app with its own rows`];
    const rel = fieldsOf(child).find((f) => f.key === spec.relation);
    const points = isSingleRelation(rel) ? /** @type {{ table?: unknown }} */ (/** @type {VField} */ (rel).relation).table : null;
    if (points !== table.id && points !== table.key) {
        return [`${fw}.rollup.relation "${spec.relation}" must be a single relation field of "${child.key}" that points at this table`];
    }
    if (spec.fn !== 'count' && !isNumberColumn(fieldsOf(child).find((x) => x.key === spec.field))) {
        return [`${fw}.rollup.field must be a number field of "${child.key}" for ${spec.fn}`];
    }
    return rollupFilterErrors(spec.filter, child, fw);
}

/**
 * A number field with a column (a stored computed field with a number result counts).
 * @param {VField | undefined} f
 */
function isNumberColumn(f) {
    if (!f || !hasColumn(f)) return false;
    if (f.type === 'number') return true;
    return f.type === 'computed' && isObj(f.computed) && (f.computed.type === 'number' || f.computed.type === 'integer');
}

/**
 * The many relation and the onDelete rule of one relation field.
 * @param {VField} field
 * @param {VTable} table
 * @param {VTable[]} tables
 * @param {string} fw
 * @returns {string[]}
 */
function relationRuleErrors(field, table, tables, fw) {
    const rel = isObj(field.relation) ? field.relation : null;
    if (!rel || (rel.many === undefined && rel.onDelete === undefined)) return [];
    /** @type {string[]} */
    const errors = [];
    if (rel.many !== undefined && rel.many !== true) errors.push(`${fw}.relation.many must be true or absent`);
    if (rel.onDelete !== undefined && (typeof rel.onDelete !== 'string' || !ON_DELETE_RULES.includes(rel.onDelete))) {
        errors.push(`${fw}.relation.onDelete must be one of ${ON_DELETE_RULES.join(', ')}`);
    }
    const target = tableBy(tables, rel.table);
    if (!ownStorage(table) || !target || !ownStorage(target)) errors.push(`${fw}: a many relation or onDelete rule links two tables of this app with their own rows`);
    return [...errors, ...relationComboErrors(field, rel, fw)];
}

/**
 * What a many relation or an onDelete rule cannot be combined with.
 * @param {VField} field
 * @param {Record<string, unknown>} rel
 * @param {string} fw
 * @returns {string[]}
 */
function relationComboErrors(field, rel, fw) {
    if (rel.many === true && (field.unique === true || field.required === true || rel.onDelete !== undefined)) {
        return [`${fw}: a many relation takes no unique, required or onDelete`];
    }
    if (rel.onDelete === 'setNull' && field.required === true) return [`${fw}: onDelete "setNull" cannot empty a required relation`];
    return [];
}

/**
 * @param {VTable} table
 * @param {string} where
 * @returns {string[]}
 */
function indexErrors(table, where) {
    if (table.indexes === undefined) return [];
    const { MAX_INDEXES, MAX_INDEX_FIELDS } = LINKED_FIELD_LIMITS;
    if (!ownStorage(table)) return [`${where}.indexes: only a table with its own rows takes indexes`];
    if (!Array.isArray(table.indexes) || table.indexes.length > MAX_INDEXES) return [`${where}.indexes must be a list of at most ${MAX_INDEXES} { fields } entries`];
    /** @type {string[]} */
    const errors = [];
    const seen = new Set();
    for (const [i, entry] of table.indexes.entries()) {
        const at = `${where}.indexes[${i}]`;
        const refs = isObj(entry) && Array.isArray(entry.fields) ? entry.fields : null;
        if (!refs || !refs.length || refs.length > MAX_INDEX_FIELDS || Object.keys(entry).some((k) => k !== 'fields')) {
            errors.push(`${at} must be { fields: [1 to ${MAX_INDEX_FIELDS} field keys] }`);
            continue;
        }
        const bad = refs.filter((/** @type {unknown} */ r) => !(typeof r === 'string' && (SYSTEM_COLUMNS.includes(r) || hasColumn(fieldsOf(table).find((f) => f.key === r || f.id === r)))));
        if (bad.length) errors.push(`${at} names fields without a stored column: ${bad.map(String).join(', ')}`);
        const sig = refs.join(',');
        if (new Set(refs).size !== refs.length || seen.has(sig)) errors.push(`${at} repeats a field or another index`);
        seen.add(sig);
    }
    return errors;
}

/**
 * Every finding for the vocabulary of linkedFields.js in a model.
 * @param {{ tables?: unknown }} model
 * @returns {string[]}
 */
function linkedFieldErrors(model) {
    const tables = /** @type {VTable[]} */ (Array.isArray(model.tables) ? model.tables.filter(isObj) : []);
    /** @type {string[]} */
    const errors = [];
    for (const [ti, table] of tables.entries()) {
        const where = `tables[${ti}]`;
        errors.push(...indexErrors(table, where));
        for (const [fi, field] of fieldsOf(table).entries()) {
            const fw = `${where}.fields[${fi}]`;
            if ((field.type === 'lookup' || field.type === 'rollup') && !ownStorage(table)) {
                errors.push(`${fw}: a ${field.type} field lives on a table with its own rows`);
            } else if (field.type === 'lookup') {
                errors.push(...lookupErrors(field, table, tables, fw));
            } else if (field.type === 'rollup') {
                errors.push(...rollupErrors(field, table, tables, fw));
            } else if (field.type === 'relation') {
                errors.push(...relationRuleErrors(field, table, tables, fw));
            }
        }
    }
    return errors;
}

module.exports = { linkedFieldErrors };
