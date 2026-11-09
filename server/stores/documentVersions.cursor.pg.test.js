// @typecheck
/**
 * documentVersions.listRows pages the history list with a keyset cursor on
 * (created_at, id). The cursor carried created_at in milliseconds while the
 * column holds microseconds; compared with the rounded value, versions that
 * share the cursor row's millisecond (a save and the pre-restore snapshot of
 * one transaction, say) were skipped at a page boundary.
 *
 * Against a real Postgres (@electric-sql/pglite).
 *
 * Run: cd server && node --test stores/documentVersions.cursor.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const versions = require('./documentVersions');

const { pg, db } = pgliteDb();
const getAll = async (sql, params) => (await db.query(sql, params)).rows;

before(async () => {
    await pg.exec(`
        CREATE TABLE studio_documents (id TEXT PRIMARY KEY);
        CREATE TABLE studio_document_versions (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
            summary TEXT DEFAULT '',
            body_html TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    for (const ddl of versions.VERSION_DDL) await pg.exec(ddl);
    await pg.exec(`INSERT INTO studio_documents (id) VALUES ('d1'), ('d2')`);
    const rows = [
        ['v5', 'd1', '2026-03-01 10:00:00.789900+00'], ['v4', 'd1', '2026-03-01 10:00:00.789600+00'],
        ['v3', 'd1', '2026-03-01 10:00:00.789300+00'], ['v2', 'd1', '2026-03-01 10:00:00.789100+00'],
        ['v1', 'd1', '2026-03-01 09:00:00+00'],
        // Another document's version in the same millisecond never joins the walk.
        ['x1', 'd2', '2026-03-01 10:00:00.789500+00'],
    ];
    for (const [id, doc, at] of rows) {
        await pg.query('INSERT INTO studio_document_versions (id, document_id, created_at) VALUES ($1, $2, $3)', [id, doc, at]);
    }
});
after(async () => { await pg.close(); });

test('paging through versions that share a millisecond returns every one, once, newest first', async () => {
    for (const limit of [1, 2, 3]) {
        const seen = [];
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const out = await versions.listRows(getAll, 'd1', { limit, cursor });
            seen.push(...out.versions.map((v) => v.id));
            if (!out.nextCursor) break;
            cursor = out.nextCursor;
        }
        assert.deepEqual(seen, ['v5', 'v4', 'v3', 'v2', 'v1'], `page size ${limit}`);
    }
});

test('a cursor naming a version that is gone, or one of another document, pages from its timestamp', async () => {
    const gone = versions._test.encodeCursor('2026-03-01T09:30:00.000Z', 'nope');
    assert.deepEqual((await versions.listRows(getAll, 'd1', { cursor: gone })).versions.map((v) => v.id), ['v1']);
    // x1 belongs to d2: its real timestamp is not read for a walk of d1.
    const foreign = versions._test.encodeCursor('2026-03-01T09:30:00.000Z', 'x1');
    assert.deepEqual((await versions.listRows(getAll, 'd1', { cursor: foreign })).versions.map((v) => v.id), ['v1']);
});
