// @typecheck
/**
 * memory-sources-strip on a real Postgres (PGlite, the memory_sources table
 * of the boot ladder's schema): stored messages go, the rows stay.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('./memory-sources-strip-2026-10');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { ladderPglite, newPglite } = require('../testUtils/pgliteTemplate');
const { insertRows } = require('../testUtils/pgliteSeed');

test('nulls every stored message and touches nothing else', async () => {
    const { pg, db } = pgliteDb(ladderPglite());
    try {
        await insertRows(pg, 'memory_sources', [
            { id: 's1', memory_id: 'm1', conversation_id: 'c1', message_content: 'hello there' },
            { id: 's2', memory_id: 'm2', conversation_id: 'c2', message_content: null },
        ]);
        await migration.up({ run: db.query });
        const { rows } = await pg.query('SELECT id, memory_id, conversation_id, message_content FROM memory_sources ORDER BY id');
        assert.deepEqual(rows, [
            { id: 's1', memory_id: 'm1', conversation_id: 'c1', message_content: null },
            { id: 's2', memory_id: 'm2', conversation_id: 'c2', message_content: null },
        ], 'both rows kept, no message left');
    } finally { await pg.close(); }
});

test('a fresh database (table not there yet) is skipped, not a failure', async () => {
    const { pg, db } = pgliteDb(newPglite());
    try { await migration.up({ run: db.query }); } finally { await pg.close(); }
});

test('the migration is registered, or it never runs', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('memory-sources-strip-2026-10'));
});
