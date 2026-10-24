// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countLegacyDek, formatReport, COUNT_SQL } = require('./check-legacy-dek');
const { pgliteDb } = require('../testUtils/pgliteDb');

/** A fake db that records every statement and answers the count query. */
function fakeDb(row) {
    const sent = [];
    return {
        sent,
        async query(sql) {
            sent.push(sql.trim());
            return sql === COUNT_SQL ? { rows: [row] } : { rows: [] };
        },
    };
}

test('only reads: one SELECT inside a READ ONLY transaction that is rolled back', async () => {
    const db = fakeDb({ master_wrapped: '3', wrapped_without_salt: '5' });
    await countLegacyDek(db);
    assert.deepEqual(db.sent, ['BEGIN TRANSACTION READ ONLY', COUNT_SQL.trim(), 'ROLLBACK']);
    assert.match(COUNT_SQL, /^\s*SELECT\b/);
    assert.doesNotMatch(COUNT_SQL, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i);
});

test('returns the two counts as numbers (pg gives bigint COUNTs as strings)', async () => {
    assert.deepEqual(await countLegacyDek(fakeDb({ master_wrapped: '3', wrapped_without_salt: '5' })),
        { masterWrappedDEK: 3, wrappedDEKWithoutKekSalt: 5 });
    assert.deepEqual(await countLegacyDek(fakeDb({})), { masterWrappedDEK: 0, wrappedDEKWithoutKekSalt: 0 });
});

test('the transaction is closed even when the query fails', async () => {
    const sent = [];
    const db = { async query(sql) { sent.push(sql.trim()); if (sql === COUNT_SQL) throw new Error('no table'); return { rows: [] }; } };
    await assert.rejects(countLegacyDek(db), /no table/);
    assert.equal(sent.at(-1), 'ROLLBACK');
});

test('the report holds the counts and nothing else', () => {
    const text = formatReport({ masterWrappedDEK: 3, wrappedDEKWithoutKekSalt: 5 });
    assert.match(text, /masterWrappedDEK set:\s+3$/m);
    assert.match(text, /wrappedDEK but no kekSalt:\s+5$/m);
    assert.deepEqual(text.match(/\d+/g), ['3', '5']);
    assert.equal(formatReport({ masterWrappedDEK: 3, wrappedDEKWithoutKekSalt: 5 }, { json: true }),
        '{"masterWrappedDEK":3,"wrappedDEKWithoutKekSalt":5}');
});

test('the SQL counts what it says against a real Postgres (pglite)', async () => {
    const { pg, db } = pgliteDb();
    try {
        await pg.exec('CREATE TABLE users (id TEXT PRIMARY KEY, "masterWrappedDEK" TEXT, "wrappedDEK" TEXT, "kekSalt" TEXT)');
        const rows = [
            ['a', '{"m":1}', null, null],      // master-wrapped
            ['b', '{"m":1}', '{"w":1}', 's'],  // master-wrapped (and current)
            ['c', '', '{"w":1}', ''],          // wrapped, empty salt
            ['d', null, '{"w":1}', null],      // wrapped, no salt
            ['e', null, '{"w":1}', 'salt'],    // current scheme
            ['f', null, null, null],           // no encryption
            ['g', '', '', null],               // empty strings are not set
        ];
        for (const r of rows) await pg.query('INSERT INTO users VALUES ($1,$2,$3,$4)', r);
        const before = (await pg.query('SELECT * FROM users ORDER BY id')).rows;
        assert.deepEqual(await countLegacyDek(db), { masterWrappedDEK: 2, wrappedDEKWithoutKekSalt: 2 });
        assert.deepEqual((await pg.query('SELECT * FROM users ORDER BY id')).rows, before);
    } finally {
        await pg.close();
    }
});
