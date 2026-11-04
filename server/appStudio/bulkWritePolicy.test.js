/**
 * Which steps cost a run (actionRunLimiter) because they change many rows at once.
 *
 * Run: cd server && node --test appStudio/bulkWritePolicy.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBulkWriteStep } = require('./bulkWritePolicy.mts');

test('a filter-mode update/delete and a writeTo with replaceWhere are bulk writes', () => {
    assert.equal(isBulkWriteStep({ kind: 'delete_record', tableId: 't', filter: [{ field: 'a', op: 'eq', value: 1 }] }), true);
    assert.equal(isBulkWriteStep({ kind: 'update_record', tableId: 't', filter: [] }), true);
    assert.equal(isBulkWriteStep({ kind: 'ai_extract', writeTo: { tableId: 't', replaceWhere: [{ field: 'a', op: 'eq', value: 1 }] } }), true);
});

test('a one-row write, an upsert without replaceWhere and other steps are not', () => {
    assert.equal(isBulkWriteStep({ kind: 'delete_record', tableId: 't', recordId: { kind: 'static', value: 'r' } }), false);
    assert.equal(isBulkWriteStep({ kind: 'update_record', tableId: 't', recordId: 'r', filter: null }), false);
    assert.equal(isBulkWriteStep({ kind: 'ai_extract', writeTo: { tableId: 't', upsertKey: ['a'] } }), false);
    assert.equal(isBulkWriteStep({ kind: 'toast', filter: [] }), false);
    assert.equal(isBulkWriteStep(null), false);
});
