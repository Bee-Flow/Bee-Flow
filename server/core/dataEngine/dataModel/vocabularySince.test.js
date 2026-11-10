// @typecheck
/**
 * vocabularySince.js: which words of the data vocabulary came after the frozen base.
 *
 * The frozen base is spelled out here once. A word added to a list in vocabulary.js without a
 * mark fails with the line to add; a marked word needs no edit of this file.
 * Run: node --test core/dataEngine/dataModel/vocabularySince.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vocabulary = require('./vocabulary');
const marks = require('./vocabularySince');

/** The data vocabulary every app made before schema version 3 can rely on. Never edited. */
const FROZEN_BASE = Object.freeze({
    fieldTypes: ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'relation', 'file', 'computed'],
    filterOps: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'between', 'isNull', 'isNotNull'],
    aggFns: ['count', 'sum', 'avg', 'min', 'max', 'p50', 'p90'],
    dateBuckets: ['hour', 'day', 'week', 'month', 'quarter', 'year'],
});
const LISTS = /** @type {const} */ ({ fieldTypes: 'FIELD_TYPES', filterOps: 'FILTER_OPS', aggFns: 'AGG_FNS', dateBuckets: 'DATE_BUCKETS' });
const WHERE = 'server/core/dataEngine/dataModel/vocabularySince.js';

test('every word of a list is base vocabulary or carries a mark, and the base words come first', () => {
    for (const [family, listName] of Object.entries(LISTS)) {
        const list = vocabulary[listName];
        const base = FROZEN_BASE[/** @type {keyof typeof FROZEN_BASE} */ (family)];
        assert.deepEqual(list.slice(0, base.length), base, `${listName}: the base words keep their place; add a new word AFTER them`);
        for (const word of list.slice(base.length)) {
            const mark = marks.DATA_VOCABULARY_MARKS[/** @type {keyof typeof FROZEN_BASE} */ (family)][word];
            assert.ok(mark && marks.isAboveBase(mark.since),
                `${listName} gained "${word}": add \`${word}: { since: 3, description: '…' }\` to DATA_VOCABULARY_MARKS.${family} in ${WHERE}`);
        }
    }
    assert.deepEqual([...marks.BASE_FIELD_TYPES], FROZEN_BASE.fieldTypes);
    assert.deepEqual([...marks.BASE_FILTER_OPS], FROZEN_BASE.filterOps);
    assert.deepEqual([...marks.BASE_AGG_FNS], FROZEN_BASE.aggFns);
    assert.deepEqual([...marks.BASE_DATE_BUCKETS], FROZEN_BASE.dateBuckets);
});

test('every shipped mark is complete and marks a word that exists', () => {
    for (const [family, table] of Object.entries(marks.DATA_VOCABULARY_MARKS)) {
        const list = family === 'fieldOptions' ? null : marks.FAMILY_LISTS[/** @type {keyof typeof marks.FAMILY_LISTS} */ (family)];
        for (const [word, mark] of Object.entries(table)) {
            const at = `DATA_VOCABULARY_MARKS.${family}.${word} (${WHERE})`;
            assert.ok(Number.isInteger(mark.since) && mark.since >= 3, `${at}: "since" is an integer of 3 or more`);
            assert.ok(typeof mark.description === 'string' && mark.description.trim(), `${at}: "description" says what the word does`);
            if (list) assert.ok(list.includes(word), `${at}: "${word}" is not in the list it marks; append it to the list in vocabulary.js`);
            else assert.ok(typeof mark.shape === 'string' && mark.shape.trim(), `${at}: a field option gives its value's "shape"`);
        }
    }
});

test('a mark kept in another table says the same as this one', () => {
    // A package that marked its field types in a FIELD_TYPE_SINCE of its own (`{ <type>: 3 }`)
    // moves each entry to DATA_VOCABULARY_MARKS.fieldTypes; until then the two may not disagree.
    const own = /** @type {Record<string, unknown>} */ (vocabulary).FIELD_TYPE_SINCE;
    if (own === undefined) return;
    const here = Object.fromEntries(Object.entries(marks.DATA_VOCABULARY_MARKS.fieldTypes).map(([word, mark]) => [word, mark.since]));
    assert.deepEqual(here, { ...(/** @type {object} */ (own)) }, `move the entries of vocabulary.FIELD_TYPE_SINCE to DATA_VOCABULARY_MARKS.fieldTypes in ${WHERE}, each as { since, description }`);
});

test('the base lists and the query marks follow a mark table', () => {
    const fixture = {
        fieldTypes: { computed: { since: 3, description: 'x' } },
        filterOps: { isNull: { since: 3, description: 'x' }, eq: { since: 2, description: 'still base' } },
        aggFns: { p90: { since: 4, description: 'x' } },
        dateBuckets: {},
    };
    // Against the live lists: a word a feature appended (and marked in the shipped table, not in
    // this fixture) stays in, so this holds whatever ships.
    const base = marks.baseVocabulary(fixture);
    assert.deepEqual([...base.FIELD_TYPES], vocabulary.FIELD_TYPES.filter((t) => t !== 'computed'));
    assert.deepEqual([...base.FILTER_OPS], vocabulary.FILTER_OPS.filter((t) => t !== 'isNull'));
    assert.deepEqual([...base.AGG_FNS], vocabulary.AGG_FNS.filter((t) => t !== 'p90'));
    assert.equal(base.DATE_BUCKETS, vocabulary.DATE_BUCKETS, 'nothing marked: the very same list');
    assert.deepEqual(marks.queryValuesSince(fixture), { op: { isNull: 3 }, fn: { p90: 4 }, bucket: {} });
    for (const since of [undefined, null, 2, '3', 3.5]) assert.equal(marks.isAboveBase(since), false, String(since));
});
