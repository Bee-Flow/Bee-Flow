// @typecheck strict
/**
 * Data engine — which words of the data vocabulary (vocabulary.js) were added after the
 * frozen base, and what each one means.
 *
 * vocabulary.js keeps the lists themselves (FIELD_TYPES, FILTER_OPS, AGG_FNS, DATE_BUCKETS,
 * ROW_RULE_WORDS): a new word is appended there, AFTER the base words, so every enum built from a list keeps
 * its base prefix. The word is then marked here, in the table of its family:
 *
 *   fieldTypes    a field type                       autonumber: { since: 3, description }
 *   fieldOptions  a key of a field declaration       validation: { since: 3, shape, description }
 *   filterOps     a filter operator                  search:     { since: 3, description }
 *   aggFns        an aggregate function              median:     { since: 3, description }
 *   dateBuckets   a date bucket of a group           fortnight:  { since: 3, description }
 *   rowRule       a word of a row rule               viewer.email: { since: 3, description }
 *
 * `description` is one sentence or more on what the word does; `shape` (field options only)
 * is the value's shape as catalogue text. A word without a mark is base vocabulary.
 *
 * What a mark does:
 *   - The App Studio builder's pinned prompt and the wording of its tool schemas name the BASE
 *     words only (BASE_FIELD_TYPES …), so they do not move when a word is added. The marked
 *     words are listed in the prompt's extension index under the `data` family and served in
 *     full by app_inspect_catalog (appStudio/catalogTiers.mts); the schemas' enums accept them.
 *   - A filter operator, aggregate function or date bucket used in a binding or a step of an
 *     app definition stores that definition with at least the mark's schemaVersion
 *     (appStudio/schemaSince.mts). Field types, field options and row rules live in the data
 *     model, which has no schema version of its own.
 *
 * LAYER: core/, literals and vocabulary.js only (see the note there).
 */

'use strict';

const vocabulary = require('./vocabulary');

/**
 * @typedef {{ since: number, description: string, shape?: string }} VocabularyMark
 * @typedef {'fieldTypes' | 'fieldOptions' | 'filterOps' | 'aggFns' | 'dateBuckets' | 'rowRule'} VocabularyFamily
 */

/** @type {Readonly<Record<VocabularyFamily, Readonly<Record<string, VocabularyMark>>>>} */
const DATA_VOCABULARY_MARKS = Object.freeze({
    fieldTypes: Object.freeze({}),
    fieldOptions: Object.freeze({}),
    filterOps: Object.freeze({}),
    aggFns: Object.freeze({}),
    dateBuckets: Object.freeze({}),
    // Row rules (`access.rowFilters[role]` of a table): what a rule can know about the viewer
    // beyond id, role and organizationId, the membership test and the rule per operation.
    rowRule: Object.freeze({
        'viewer.orgId': Object.freeze({
            since: 3,
            description: 'The organisation of the viewer\'s own account. The same on every path, and null for an anonymous visitor of a public page: use it in a new rule where viewer.organizationId stood.',
        }),
        'viewer.email': Object.freeze({
            since: 3,
            description: 'The address of the viewer\'s account. Compared like any value: record.assignee == viewer.email.',
        }),
        'viewer.groups': Object.freeze({
            since: 3,
            description: 'The ids of the groups the viewer is in, a list for the right of `in`. Never compared as one value: write record.team in viewer.groups.',
        }),
        in: Object.freeze({
            since: 3,
            description: 'Membership of a list of the viewer: record.team in viewer.groups. The left side is a text or select field (or id, created_by, org_id), and a viewer in no group matches no row.',
        }),
        perOperation: Object.freeze({
            since: 3,
            description: 'A row rule per operation in place of one rule for all three. rowFilters[role] is then { read, update, delete } with a formula each, every key optional: an operation left out follows the read formula (never broader than read), and the formula `true` gives that operation every row.',
        }),
    }),
});

/** The list each family marks words of (field options are keys, not a list). */
const FAMILY_LISTS = Object.freeze({
    fieldTypes: vocabulary.FIELD_TYPES,
    filterOps: vocabulary.FILTER_OPS,
    aggFns: vocabulary.AGG_FNS,
    dateBuckets: vocabulary.DATE_BUCKETS,
    rowRule: vocabulary.ROW_RULE_WORDS,
});

/**
 * True for a `since` above the base schema version (2).
 * @param {unknown} since
 */
function isAboveBase(since) {
    return typeof since === 'number' && Number.isInteger(since) && since > 2;
}

/**
 * `list` without the words `marks` marks above the base. The same array when nothing is
 * marked, so a caller can tell by identity that the two tiers are one.
 * @template {readonly string[]} L
 * @param {L} list
 * @param {Readonly<Record<string, { since?: unknown }>>} marks
 * @returns {readonly string[]}
 */
function baseWords(list, marks) {
    const out = list.filter((word) => !(Object.hasOwn(marks, word) && isAboveBase(marks[word].since)));
    return out.length === list.length ? list : Object.freeze(out);
}

/**
 * word → since, for the marked words of one family.
 * @param {Readonly<Record<string, { since?: unknown }>>} marks
 * @returns {Record<string, number>}
 */
function sinceMap(marks) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [word, mark] of Object.entries(marks)) {
        if (isAboveBase(mark.since)) out[word] = /** @type {number} */ (mark.since);
    }
    return out;
}

/**
 * The base tier of the four lists, for a given mark table (the shipped one by default).
 * @param {Readonly<Record<string, Readonly<Record<string, { since?: unknown }>>>>} [marks]
 */
function baseVocabulary(marks = DATA_VOCABULARY_MARKS) {
    return {
        FIELD_TYPES: baseWords(vocabulary.FIELD_TYPES, marks.fieldTypes || {}),
        FILTER_OPS: baseWords(vocabulary.FILTER_OPS, marks.filterOps || {}),
        AGG_FNS: baseWords(vocabulary.AGG_FNS, marks.aggFns || {}),
        DATE_BUCKETS: baseWords(vocabulary.DATE_BUCKETS, marks.dateBuckets || {}),
    };
}

/**
 * The marks of the query vocabulary as an app definition spells it: the key a clause holds
 * the word under (`op` of a filter clause, `fn` of an aggregate, `bucket` of a group) → word → since.
 * @param {Readonly<Record<string, Readonly<Record<string, { since?: unknown }>>>>} [marks]
 */
function queryValuesSince(marks = DATA_VOCABULARY_MARKS) {
    return { op: sinceMap(marks.filterOps || {}), fn: sinceMap(marks.aggFns || {}), bucket: sinceMap(marks.dateBuckets || {}) };
}

const BASE = baseVocabulary();

module.exports = {
    DATA_VOCABULARY_MARKS,
    FAMILY_LISTS,
    BASE_FIELD_TYPES: BASE.FIELD_TYPES,
    BASE_FILTER_OPS: BASE.FILTER_OPS,
    BASE_AGG_FNS: BASE.AGG_FNS,
    BASE_DATE_BUCKETS: BASE.DATE_BUCKETS,
    QUERY_VALUES_SINCE: queryValuesSince(),
    baseVocabulary,
    queryValuesSince,
    isAboveBase,
};
