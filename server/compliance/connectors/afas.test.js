'use strict';

/**
 * AFAS connector — it reads one page of 100 rows, so a full page is flagged
 * `truncated` (the population is "at least" that), and the snapshot keeps the
 * row count and field names only.
 *
 * Run: cd server && node --test compliance/connectors/afas.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const connector = require('./afas');

const settings = { base_url: 'https://12345.rest.afas.online/ProfitRestServices', connector: 'Profit_Employees' };
const answering = (rows) => async () => ({ ok: true, json: async () => ({ rows }) });

test('a full page of 100 rows is flagged truncated', async () => {
    const [row] = await connector.collect({ secret: { token: 'abc' }, settings, safeFetch: answering(Array(100).fill({ EmployeeId: 'E1' })) });
    assert.equal(row.payload.rows, 100);
    assert.equal(row.payload.truncated, true);
});

test('a short page is the whole population; no field values are kept', async () => {
    const [row] = await connector.collect({ secret: { token: 'abc' }, settings, safeFetch: answering([{ EmployeeId: 'E1', Name: 'Jan Jansen' }]) });
    assert.equal(row.payload.truncated, false);
    assert.deepEqual(row.payload.fields, ['EmployeeId', 'Name']);
    assert.ok(!JSON.stringify(row).includes('Jansen'));
});
