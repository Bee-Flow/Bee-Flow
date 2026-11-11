// @typecheck strict
/**
 * Data engine — the vocabulary of fields that read through other rows, of the many-to-many
 * relation, of the rule a relation follows when the row it points at is deleted, and of the
 * declared indexes of a table (all after the frozen base; their catalogue marks are in
 * vocabularySince.js).
 *
 *   lookup     { type: 'lookup', lookup: { relation: <relation field of this table>, field: <field of the related table> } }
 *              Read-only and without a column: the value of one field of the row a relation
 *              points at, read under THAT table's row rules (an unreadable row reads null).
 *   rollup     { type: 'rollup', rollup: { table: <child table>, relation: <relation field of the child pointing here>,
 *                fn: count|sum|min|max|avg, field?: <child field>, filter?: [{ field, op, value }] } }
 *              Read-only and without a column: one figure over the child rows that point at
 *              this row, counted under the CHILD table's row rules (a row the viewer may not
 *              read is not counted).
 *   relation.many: true
 *              A relation that holds several ids. No column: the links live in a junction table
 *              the data engine manages (junctionName), created and dropped with the field.
 *   relation.onDelete: 'restrict' | 'setNull' | 'cascade'
 *              What deleting the row a (single) relation points at does to the rows pointing at
 *              it. Absent: what it always did (the database's own foreign key decides).
 *   table.indexes: [{ fields: [<field key>, …] }]
 *              Plain indexes on columns of the table, named from stable ids (tableIndexName) so a
 *              rename never rebuilds one.
 *
 * Neither a lookup nor a rollup nor a many relation has a column, so none of them can be
 * filtered, sorted, grouped or aggregated on by name (queryCompilerCore.resolveColumn refuses
 * them); a many relation answers the filter operators `contains` and `notContains` through its
 * junction (queryCompilerMany.mts).
 *
 * LAYER: core/. Literals and pure helpers only.
 */

'use strict';

const crypto = require('crypto');

/** The figures a rollup computes. */
const ROLLUP_FNS = Object.freeze(['count', 'sum', 'min', 'max', 'avg']);

/** What `relation.onDelete` may say. */
const ON_DELETE_RULES = Object.freeze(['restrict', 'setNull', 'cascade']);

/** The operators a many relation takes in a filter: does its list hold this id. */
const MANY_FILTER_OPS = Object.freeze(['contains', 'notContains']);

/** The two columns of every junction table. */
const JUNCTION_SOURCE = 'source_id';
const JUNCTION_TARGET = 'target_id';

/** Validity limits of a model and of one write (constants: they decide what is valid). */
const LINKED_FIELD_LIMITS = Object.freeze({
    MAX_ROLLUP_FILTERS: 5,
    MAX_MANY_LINKS: 200,
    MAX_INDEXES: 10,
    MAX_INDEX_FIELDS: 4,
});

/** The rows one delete may remove or change through `onDelete` rules unless STUDIO_APP_CASCADE_MAX_ROWS says otherwise. */
const DEFAULT_CASCADE_MAX_ROWS = 500;
/** How many relations deep a cascade follows (a validity limit of the walk, not a budget). */
const MAX_CASCADE_DEPTH = 5;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {{ id?: unknown, key?: unknown, type?: unknown, relation?: unknown, lookup?: unknown, rollup?: unknown }} AnyField
 */

/**
 * A relation that holds several ids.
 * @param {AnyField | null | undefined} field
 */
function isManyRelation(field) {
    return !!field && field.type === 'relation' && isObject(field.relation) && field.relation.many === true;
}

/**
 * A field whose value is read through other rows and never written: lookup or rollup.
 * @param {AnyField | null | undefined} field
 */
function isDerivedLinkField(field) {
    return !!field && (field.type === 'lookup' || field.type === 'rollup');
}

/**
 * A field without a column of its own: lookup, rollup, many relation.
 * @param {AnyField | null | undefined} field
 */
function isColumnlessLinkField(field) {
    return isDerivedLinkField(field) || isManyRelation(field);
}

/**
 * The onDelete rule of a single relation, or null (absent: today's behaviour).
 * @param {AnyField | null | undefined} field
 * @returns {'restrict' | 'setNull' | 'cascade' | null}
 */
function onDeleteOf(field) {
    if (!field || field.type !== 'relation' || !isObject(field.relation) || field.relation.many === true) return null;
    const rule = field.relation.onDelete;
    return rule === 'restrict' || rule === 'setNull' || rule === 'cascade' ? rule : null;
}

/** @param {string} text */
function shortHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The junction table of a many relation, from the stable ids (a rename never moves it). Starts
 * with an underscore, which no table key can (KEY_RE), so it never meets an app table.
 * @param {string} tableId
 * @param {string} fieldId
 */
function junctionName(tableId, fieldId) {
    return `_jn_${shortHash(`${tableId}:${fieldId}`)}`;
}

/**
 * The name of a declared index, from the stable ids of the table and its fields in order.
 * @param {string} tableId
 * @param {readonly string[]} fieldIds
 */
function tableIndexName(tableId, fieldIds) {
    return `ixd_${shortHash(`${tableId}:${fieldIds.join(',')}`)}`;
}

/**
 * STUDIO_APP_CASCADE_MAX_ROWS: the rows one delete may remove or change through onDelete rules.
 * Default 500; 0 means no limit.
 * @param {Record<string, string | undefined>} [env]
 */
function cascadeMaxRows(env = process.env) {
    const raw = env.STUDIO_APP_CASCADE_MAX_ROWS;
    if (raw === undefined || raw === '') return DEFAULT_CASCADE_MAX_ROWS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_CASCADE_MAX_ROWS;
    return n === 0 ? Infinity : Math.floor(n);
}

module.exports = {
    ROLLUP_FNS,
    ON_DELETE_RULES,
    MANY_FILTER_OPS,
    JUNCTION_SOURCE,
    JUNCTION_TARGET,
    LINKED_FIELD_LIMITS,
    DEFAULT_CASCADE_MAX_ROWS,
    MAX_CASCADE_DEPTH,
    isManyRelation,
    isDerivedLinkField,
    isColumnlessLinkField,
    onDeleteOf,
    junctionName,
    tableIndexName,
    cascadeMaxRows,
};
