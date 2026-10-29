'use strict';

/**
 * The sync block's child and dependent table gates (connectorSyncTables.js):
 * every finding is pushed in the order the fields are read, and a shape that
 * is fine adds nothing.
 *
 * Run: cd server && node --test appStudio/dataModel/connectorSyncTables.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateSyncChildren, validateSyncDependents } = require('./connectorSyncTables');

const TABLE_IDS = new Set(['tbl_main', 'tbl_att', 'tbl_lines']);
const W = 'connectors[0]';

test('children: a well-formed child adds nothing, an absent list is skipped', () => {
    const errors = [];
    validateSyncChildren({ tableId: 'tbl_main' }, TABLE_IDS, W, errors);
    validateSyncChildren({
        tableId: 'tbl_main',
        children: [{ tableId: 'tbl_att', level: 1, relationField: 'message', retentionCascade: true }],
    }, TABLE_IDS, W, errors);
    assert.deepEqual(errors, []);
});

test('children: grain and column findings, in field order', () => {
    const errors = [];
    validateSyncChildren({
        tableId: 'tbl_main',
        children: [
            { tableId: 'tbl_main', level: 1, relationField: 'message' },
            { tableId: 'tbl_nope', level: 1, parentLevel: 1, relationField: 'Bad', retentionField: 'sent_at', retentionCascade: true },
            'not an object',
        ],
    }, TABLE_IDS, W, errors);
    assert.deepEqual(errors, [
        `${W}.sync.children[0].tableId must differ from the connector's main table`,
        `${W}.sync.children[1].tableId must be a table in this app`,
        `${W}.sync.children[1].level 1 is used by more than one table`,
        `${W}.sync.children[1].parentLevel must be a lower grain than ${W}.sync.children[1].level`,
        `${W}.sync.children[1].relationField must be the column holding the parent's record`,
        `${W}.sync.children[1] cannot both cascade retention from its parent and carry its own retentionField`,
        `${W}.sync.children[2] must be an object`,
    ]);
});

test('children: a non-array list is one finding', () => {
    const errors = [];
    validateSyncChildren({ tableId: 'tbl_main', children: {} }, TABLE_IDS, W, errors);
    assert.deepEqual(errors, [`${W}.sync.children must be an array of child tables`]);
});

test('dependents: own date column and cascade are checked against the real columns', () => {
    const tablesById = new Map([
        ['tbl_lines', { fields: [
            { key: 'noted_at', type: 'text' },
            { key: 'ticket', type: 'relation', relation: { table: 'tbl_att' } },
        ] }],
    ]);
    const errors = [];
    validateSyncDependents({
        tableId: 'tbl_main',
        dependents: [
            { tableId: 'tbl_lines', retentionField: 'noted_at' },
            { tableId: 'tbl_lines', retentionCascade: true, parentTableId: 'tbl_main', relationField: 'ticket' },
            { tableId: 'tbl_lines', extra: 1, retentionField: 'missing' },
        ],
    }, TABLE_IDS, tablesById, W, errors);
    assert.deepEqual(errors, [
        `${W}.sync.dependents[0].retentionField "noted_at" must be a date or datetime column, not text`,
        `${W}.sync.dependents[1].relationField "ticket" does not point at parentTableId "tbl_main"`,
        `${W}.sync.dependents[2].extra is not allowed — a dependent may only carry { tableId, retentionField } or { tableId, relationField, parentTableId, retentionCascade }`,
        `${W}.sync.dependents[2].retentionField "missing" is not a column on that table`,
    ]);
});

test('dependents: without field metadata only the shape is checked', () => {
    const errors = [];
    validateSyncDependents({
        tableId: 'tbl_main',
        dependents: [{ tableId: 'tbl_main', retentionCascade: 'yes', relationField: 'ticket' }],
    }, TABLE_IDS, null, W, errors);
    assert.deepEqual(errors, [
        `${W}.sync.dependents[0].tableId must differ from the connector's main table`,
        `${W}.sync.dependents[0].retentionCascade must be true or false`,
        `${W}.sync.dependents[0].parentTableId must be a table in this app`,
    ]);
});
