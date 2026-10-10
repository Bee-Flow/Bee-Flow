const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('./memory-origin-repair-2026-10');

test('relabels only explicit rows that have a memory_sources row', async () => {
    const calls = [];
    await migration.up({ run: async (sql) => { calls.push(sql); return { rowCount: 2 }; } });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /SET origin = 'inferred'/);
    assert.match(calls[0], /origin = 'explicit'/);
    assert.match(calls[0], /EXISTS \(SELECT 1 FROM memory_sources/);
});

test('a database without the column is skipped, not a failure', async () => {
    await migration.up({ run: async () => { throw Object.assign(new Error('column "origin" does not exist'), { code: '42703' }); } });
});
