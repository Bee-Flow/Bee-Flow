/**
 * A KB id (or document id) that is not even shaped like a UUID.
 *
 * `knowledge_bases.id` and `documents.id` are both `UUID PRIMARY KEY DEFAULT
 * gen_random_uuid()` (see the DDL in this file) and no insert anywhere ever
 * supplies an explicit id — createKB and every documents insert leave the
 * column to the default. So a value that is not UUID-shaped can never be a
 * real row: it means "no such base/document", the same as a well-formed id
 * that simply is not in the table.
 *
 * Before this guard, getKB/getDocument handed a value like `not-a-uuid`
 * straight to Postgres, which refuses the cast (`invalid input syntax for
 * type uuid`) — every route layers `if (!kb) return 404` on top, but the
 * store call itself throws first, so the client got a 500. This pins the
 * short-circuit: the store never even reaches the database for a
 * malformed id, and a well-formed one still does (so a real lookup keeps
 * working).
 *
 * Run: cd server && node --test --test-force-exit stores/knowledgeBases.idGuard.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../testUtils/stubRequire');

const calls = { getOne: [] };
const stub = {
    async exec() {},
    async run() { return { rowCount: 0, rows: [] }; },
    async getOne(sql, params) {
        calls.getOne.push({ sql, params });
        return null;
    },
    async getAll() { return []; },
    async getClient() { return null; },
};

const restore = installResolveStub({ '../db': stub });
after(() => restore());

const kb = require('./knowledgeBases');

before(async () => { await kb.initDB(); calls.getOne.length = 0; });
beforeEach(() => { calls.getOne.length = 0; });

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

test('getKB("not-a-uuid") answers null without reaching Postgres', async () => {
    const row = await kb.getKB('not-a-uuid');
    assert.strictEqual(row, null);
    assert.strictEqual(calls.getOne.length, 0, 'a malformed id must never be sent to the database');
});

test('getKB("") and getKB(undefined) also answer null without a query', async () => {
    assert.strictEqual(await kb.getKB(''), null);
    assert.strictEqual(await kb.getKB(undefined), null);
    assert.strictEqual(calls.getOne.length, 0);
});

test('getKB(<well-formed uuid>) still queries the database', async () => {
    await kb.getKB(VALID_UUID);
    assert.strictEqual(calls.getOne.length, 1, 'a real lookup must still happen for a UUID-shaped id');
    assert.deepStrictEqual(calls.getOne[0].params, [VALID_UUID]);
});

test('getDocument("not-a-uuid") answers null without reaching Postgres', async () => {
    const row = await kb.getDocument('not-a-uuid');
    assert.strictEqual(row, null);
    assert.strictEqual(calls.getOne.length, 0, 'a malformed id must never be sent to the database');
});

test('getDocument(<well-formed uuid>) still queries the database', async () => {
    await kb.getDocument(VALID_UUID);
    assert.strictEqual(calls.getOne.length, 1);
    assert.deepStrictEqual(calls.getOne[0].params, [VALID_UUID]);
});
