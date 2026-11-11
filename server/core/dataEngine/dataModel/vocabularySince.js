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
 *                 (`access`, the column rights of a field, is one of them: columnRights.mts)
 *   tableOptions  a key of a table declaration       indexes:    { since: 3, shape, description }
 *   filterOps     a filter operator                  search:     { since: 3, description }
 *   aggFns        an aggregate function              median:     { since: 3, description }
 *   dateBuckets   a date bucket of a group           fortnight:  { since: 3, description }
 *   rowRule       a word of a row rule               viewer.email: { since: 3, description }
 *
 * `description` is one sentence or more on what the word does; `shape` (field options only)
 * is the value's shape as catalogue text (field and table options only). A word without a mark is base vocabulary.
 *
 * What a mark does:
 *   - The App Studio builder's pinned prompt and the wording of its tool schemas name the BASE
 *     words only (BASE_FIELD_TYPES …), so they do not move when a word is added. The marked
 *     words are listed in the prompt's extension index under the `data` family and served in
 *     full by app_inspect_catalog (appStudio/catalogTiers.mts); the schemas' enums accept them.
 *   - A filter operator, aggregate function or date bucket used in a binding or a step of an
 *     app definition stores that definition with at least the mark's schemaVersion
 *     (appStudio/schemaSince.mts). Field types, field and table options and row rules live in the data
 *     model, which has no schema version of its own.
 *
 * LAYER: core/, literals and vocabulary.js only (see the note there).
 */

'use strict';

const vocabulary = require('./vocabulary');
const linkedFields = require('./linkedFields');

/**
 * @typedef {{ since: number, description: string, shape?: string }} VocabularyMark
 * @typedef {'fieldTypes' | 'fieldOptions' | 'tableOptions' | 'filterOps' | 'aggFns' | 'dateBuckets' | 'rowRule'} VocabularyFamily
 */

/** @type {Readonly<Record<VocabularyFamily, Readonly<Record<string, VocabularyMark>>>>} */
const DATA_VOCABULARY_MARKS = Object.freeze({
    fieldTypes: Object.freeze({
        autonumber: Object.freeze({
            since: 3,
            description: 'A whole number the server assigns on create: 1, 2, 3 and on per table. '
                + 'Read-only and always unique: never write, seed or default it. App tables only (not in an automation datatable).',
        }),
        json: Object.freeze({
            since: 3,
            description: 'A JSON value: an object, an array, a number, a string or a boolean. '
                + 'Stored as JSON text. A written string must itself be JSON text. App tables only.',
        }),
        user: Object.freeze({
            since: 3,
            description: 'The user id of a member of the organisation. '
                + 'dynamicDefault "currentUser.id" fills it with the signed-in user on create. App tables only.',
        }),
        lookup: Object.freeze({
            since: 3,
            description: 'Shows one field of the record a relation field points at. '
                + 'Read-only, no column: give it lookup { relation, field }. It reads null when the viewer may not read that record, '
                + 'and it cannot be filtered or sorted on (filter on "<relation>.<field>" instead). App tables only.',
        }),
        rollup: Object.freeze({
            since: 3,
            description: 'A count, sum, min, max or average over the records pointing here. '
                + 'Read-only, no column: give it rollup { table, relation, fn, field?, filter? }. Only the child records the viewer may read are counted, '
                + 'an empty count reads 0 and an empty sum/min/max/avg reads null. It cannot be filtered, sorted or aggregated on. App tables only.',
        }),
    }),
    fieldOptions: Object.freeze({
        validation: Object.freeze({
            since: 3,
            shape: '{ min?, max?, minLength?, maxLength?, pattern?, enforceOptions?, message? } | null',
            description: 'Rules every write of this field must pass, checked by the server. '
                + 'number: min, max. text: minLength, maxLength, pattern (a case-sensitive regular expression, e.g. "^[0-9]{4}[A-Z]{2}$"). '
                + 'select/multiselect: enforceOptions true accepts only the listed options. message replaces the generated error sentence. '
                + 'An empty value always passes (use required for that), and rows already stored are not re-checked. null removes the rules.',
        }),
        dynamicDefault: Object.freeze({
            since: 3,
            shape: `${Object.keys(vocabulary.DYNAMIC_DEFAULTS.types).map((v) => JSON.stringify(v)).join(' | ')} | null`,
            description: 'A value filled in when a record is created without one. '
                + '"now" on a datetime field, "today" (UTC date) on a date field, "currentUser.id" (the signed-in user\'s id) on a text or user field. '
                + 'Not together with default. null removes it.',
        }),
        format: Object.freeze({
            since: 3,
            shape: `${vocabulary.TEXT_FORMATS.values.map((v) => JSON.stringify(v)).join(' | ')} | null`,
            description: 'The kind of text a text field holds, checked on every write. '
                + 'email: an e-mail address. url: a web address (https:// or http://). phone: a phone number. '
                + 'The column stays text, so adding or removing it migrates nothing. null removes it.',
        }),
        display: Object.freeze({
            since: 3,
            shape: `{ currency?, decimals?, unit?, dateStyle?: ${vocabulary.FIELD_DISPLAY.dateStyles.join('|')} } | null`,
            description: 'How the value is shown, never how it is stored. '
                + `number/computed: currency (an ISO code like "EUR"), decimals (0-${vocabulary.FIELD_DISPLAY.MAX_DECIMALS}), unit (a short suffix like "kg", not with currency). `
                + 'date/datetime: dateStyle. null removes it.',
        }),
        access: Object.freeze({
            since: 3,
            shape: '{ read?: [roleKey, …], write?: [roleKey, …] } | null',
            description: 'Column rights: which roles may read the field and which may write it. '
                + 'read: only these roles (and the owner) get the field. For every other role it is left out of each record and cannot be used in a filter, sort, search, group or aggregate (such a read is refused), '
                + 'so do not bind a chart, a filter or a sort that other roles see to it. A computed field over a hidden field is hidden too. '
                + 'write: only these roles may set the field. Left out, write follows read. An empty list means the owner only, and "public" has the field only when a list names it. '
                + 'Not on a linked table. A unique field cannot be writable by a role that may not read it, and a relation with onDelete takes no read list. '
                + 'A lookup through a hidden relation is hidden too; a lookup or rollup that reads a field the role may not read on the other table reads null. null removes the rights.',
        }),
        lookup: Object.freeze({
            since: 3,
            shape: '{ relation: <relation field key of this table>, field: <field key of the related table> }',
            description: 'What a lookup field shows: a field of the record its relation points at. '
                + 'relation is a single relation field of the same table, field a stored field (or created_at, updated_at) of the table it points at, '
                + 'not another lookup or rollup.',
        }),
        rollup: Object.freeze({
            since: 3,
            shape: `{ table: <child table id or key>, relation: <relation field key of the child pointing here>, fn: ${linkedFields.ROLLUP_FNS.join('|')}, field?: <number field of the child>, filter?: [{ field, op, value }] }`,
            description: 'What a rollup field computes over the child records pointing here. '
                + 'field is required for every fn but count. filter (at most '
                + `${linkedFields.LINKED_FIELD_LIMITS.MAX_ROLLUP_FILTERS} clauses) keeps only the child records whose own fields match, e.g. [{ "field": "status", "op": "eq", "value": "open" }].`,
        }),
        'relation.many': Object.freeze({
            since: 3,
            shape: 'true',
            description: 'A relation that holds several records: its value is a list of record ids. '
                + 'Write the whole list ([] clears it), read it as that list, expand it to the records, and filter with op "contains" / "notContains" and one id. '
                + 'Ids of records the viewer may not read are left out of the list and are kept when the viewer writes it. Not with unique, required or onDelete. '
                + 'App tables only, pointing at an app table.',
        }),
        'relation.onDelete': Object.freeze({
            since: 3,
            shape: `${linkedFields.ON_DELETE_RULES.map((v) => JSON.stringify(v)).join(' | ')} | null`,
            description: 'What deleting a record does to the records whose relation points at it. '
                + '"restrict": the delete is refused while any points at it. "setNull": their relation is emptied. "cascade": they are deleted too, and so on down. '
                + 'The person deleting must be allowed to change (setNull) or delete (cascade) every one of them, or nothing is deleted. '
                + `At most ${linkedFields.DEFAULT_CASCADE_MAX_ROWS} records per delete by default. Leave it out for the plain behaviour. Single relations between app tables only.`,
        }),
    }),
    // Keys of a table declaration (`model.tables[]`) beside id, key, name, icon, fields, access and source.
    tableOptions: Object.freeze({
        indexes: Object.freeze({
            since: 3,
            shape: `[{ fields: [<field key>, …] }] (at most ${linkedFields.LINKED_FIELD_LIMITS.MAX_INDEXES}, each 1-${linkedFields.LINKED_FIELD_LIMITS.MAX_INDEX_FIELDS} fields)`,
            description: 'Indexes that make filters and sorts on these columns fast on big tables. '
                + 'Each lists stored columns in order (no lookup, rollup, many relation or read-time computed field). '
                + 'Adding or removing one never rebuilds the table or changes a row. App tables only.',
        }),
    }),
    filterOps: Object.freeze({}),
    aggFns: Object.freeze({
        countDistinct: Object.freeze({
            since: 3,
            description: 'Counts the different non-empty values of a field. Needs a field: { "fn": "countDistinct", "field": "<field>", "as": "<alias>" }.',
        }),
    }),
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

/** The list each family marks words of (field and table options are keys, not a list). */
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
