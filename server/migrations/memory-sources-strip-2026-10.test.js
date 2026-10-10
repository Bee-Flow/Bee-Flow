const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let failWith = null;
const migration = require('./memory-sources-strip-2026-10');
const run = async (sql, params) => {
    calls.push({ sql, params });
    if (failWith) throw failWith;
    return { rowCount: 3 };
};

test('nulls every stored message and touches nothing else', async () => {
    calls.length = 0;
    await migration.up({ run });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /UPDATE memory_sources SET message_content = NULL WHERE message_content IS NOT NULL/);
    assert.doesNotMatch(calls[0].sql, /DELETE/i);
});

test('a fresh database (table not there yet) is skipped, not a failure', async () => {
    failWith = Object.assign(new Error('relation "memory_sources" does not exist'), { code: '42P01' });
    try { await migration.up({ run }); } finally { failWith = null; }
});

test('the migration is registered, or it never runs', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('memory-sources-strip-2026-10'));
});
