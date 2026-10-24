'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isMissingTable } = require('./isMissingTable');

test('isMissingTable: undefined_table and undefined_column by SQLSTATE', () => {
    assert.strictEqual(isMissingTable(Object.assign(new Error('x'), { code: '42P01' })), true);
    assert.strictEqual(isMissingTable({ code: '42703' }), true);
});

test('isMissingTable: the message forms of a driver without SQLSTATE', () => {
    assert.strictEqual(isMissingTable(new Error('relation "audit_log" does not exist')), true);
    assert.strictEqual(isMissingTable(new Error('column "retention" of relation "orgs" does not exist')), true);
    assert.strictEqual(isMissingTable(new Error('column foo does not exist')), true);
    assert.strictEqual(isMissingTable(new Error('SQLITE_ERROR: no such table: t')), true);
});

test('isMissingTable: every other error is not a missing table', () => {
    assert.strictEqual(isMissingTable(Object.assign(new Error('lock timeout'), { code: '55P03' })), false);
    assert.strictEqual(isMissingTable(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), false);
    assert.strictEqual(isMissingTable(new Error('Connection terminated due to connection timeout')), false);
    assert.strictEqual(isMissingTable(new Error('the file does not exist')), false);
    assert.strictEqual(isMissingTable(null), false);
    assert.strictEqual(isMissingTable(undefined), false);
    assert.strictEqual(isMissingTable('42P01'), false);
});
