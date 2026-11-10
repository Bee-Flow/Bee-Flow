// @typecheck
/**
 * The document list's date filters and the thread order cast `metadata.date`,
 * free text in a JSON bag. Against a real Postgres (pglite): one document
 * whose stored date cannot be cast must not fail the list for the whole
 * knowledge base; it reads as a document without a date.
 *
 * Run: cd server && node --test stores/kb/documentQueries.storedDate.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('../knowledgeBases');
const { GUARDED_DATE_SQL } = require('./model');

let kb;
let clean;

async function doc(base, title, date, threadId = 't1') {
    await pg.query(
        `INSERT INTO documents (tenant_id, knowledge_base_id, title, metadata) VALUES ('org1', $1, $2, $3::jsonb)`,
        [base.id, title, JSON.stringify({ date, threadId })],
    );
}

before(async () => {
    await store.initDB();
    kb = await store.createKB('owner', 'Mail archive', '', 'org1');
    clean = await store.createKB('owner', 'Clean archive', '', 'org1');
    await doc(kb, 'january', '2026-01-10T09:00:00.000Z');
    await doc(kb, 'march', '2026-03-10T09:00:00+02:00');
    await doc(kb, 'garbage', 'last Tuesday-ish');
    await doc(kb, 'no such day', '2026-02-31T09:00:00Z');
    await doc(clean, 'rfc', 'Tue, 10 Mar 2026 09:00:00 +0000');
    await doc(clean, 'iso', '2026-01-10');
});
after(close);

const titles = (rows) => rows.map((r) => r.title).sort();
const FEB_ON = { dateFrom: '2026-02-01T00:00:00Z' };

test('a stored date Postgres cannot cast does not fail the filtered list or its count', async () => {
    assert.deepEqual(titles(await store.listDocuments(kb.id, { filters: FEB_ON })), ['march']);
    assert.equal(await store.countDocuments(kb.id, FEB_ON), 1);
    assert.deepEqual(titles(await store.listDocuments(kb.id, { filters: { dateTo: '2026-02-01T00:00:00Z' } })), ['january']);
});

test('the thread view still orders by date, with the unreadable ones last', async () => {
    const rows = await store.listDocumentsByThread(kb.id, 't1');
    assert.deepEqual(rows.slice(0, 2).map((r) => r.title), ['january', 'march']);
    assert.deepEqual(titles(rows.slice(2)), ['garbage', 'no such day']);
});

test('a knowledge base without a malformed date keeps every date Postgres reads, ISO or not', async () => {
    assert.deepEqual(titles(await store.listDocuments(clean.id, { filters: FEB_ON })), ['rfc']);
    assert.equal(await store.countDocuments(clean.id, { dateTo: '2026-02-01T00:00:00Z' }), 1);
});

test('a malformed FILTER value is still an error: the guard is for stored values only', async () => {
    await assert.rejects(() => store.listDocuments(kb.id, { filters: { dateFrom: 'not-a-date' } }));
});

test('whatever the guard lets through, Postgres can cast', async () => {
    const values = [
        '2026-01-10', '2026-01-10T09:00', '2026-01-10 09:00:00', '2026-12-31T23:59:59.123456Z', '2026-03-30T09:00:00+14:00', '2026-10-31T00:00:00-0930',
        // refused by the guard
        '2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '0000-01-01', '2026-01-10T24:00:00Z', '2026-01-10T09:00:00+15:00', '10 Jan 2026', '', '2026-01-10; DROP TABLE documents',
    ];
    for (const v of values) {
        const { rows } = await pg.query(`SELECT ${GUARDED_DATE_SQL} AS d FROM (SELECT $1::jsonb AS metadata) x`, [JSON.stringify({ date: v })]);
        assert.equal(rows[0].d !== null, values.indexOf(v) < 6, `"${v}"`);
    }
});
