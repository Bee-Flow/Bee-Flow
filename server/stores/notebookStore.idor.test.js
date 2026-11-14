// @typecheck
/**
 * Notebook store cross-tenant IDOR regression tests, against a real Postgres
 * (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * deleteSource / deleteVersion are scoped to the notebook in the URL, so a
 * foreign source or version id cannot be removed through a notebook the caller
 * happens to own. `notebook_sources` and `notebook_versions` carry no user_id of
 * their own; the parent notebook is the only ownership anchor, so the routes
 * DELETE /:id/sources/:sid, POST /:id/sources/bulk-delete and
 * DELETE /:id/versions/:vid all pass the URL's notebookId through.
 *
 * Run: cd server && node --test stores/notebookStore.idor.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const notebookStore = require('./notebookStore');

test.before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT \'\')');
    await notebookStore.initDB();
    await pg.exec(`
        INSERT INTO notebooks (id, user_id) VALUES ('nb-alice', 'alice'), ('nb-bob', 'bob');
        INSERT INTO notebook_sources (id, notebook_id, type, status, storage_key) VALUES
            ('s-alice', 'nb-alice', 'url', 'ready', NULL), ('s-bob', 'nb-bob', 'url', 'ready', 'bob/blob');
        INSERT INTO notebook_versions (id, notebook_id, content, summary, content_length) VALUES
            ('v-alice', 'nb-alice', 'a', 'x', 1), ('v-bob', 'nb-bob', 'b', 'y', 1);
    `);
});
test.after(close);

const exists = async (table, id) => (await pg.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length === 1;

// ── deleteSource ──────────────────────────────────────────────────

test('deleteSource scoped to notebookId refuses a foreign source', async () => {
    // Alice owns nb-alice; she passes Bob's source id s-bob under her notebook.
    assert.strictEqual(await notebookStore.deleteSource('s-bob', 'nb-alice'), null, 'foreign source must not delete');
    assert.ok(await exists('notebook_sources', 's-bob'));
});

test('deleteSource scoped to notebookId deletes an owned source', async () => {
    const src = await notebookStore.deleteSource('s-alice', 'nb-alice');
    assert.ok(src && src.id === 's-alice');
    assert.ok(!(await exists('notebook_sources', 's-alice')));
    assert.ok(await exists('notebook_sources', 's-bob'), 'and only that one');
});

// ── deleteVersion ─────────────────────────────────────────────────

test('deleteVersion scoped to notebookId refuses a foreign version', async () => {
    assert.strictEqual(await notebookStore.deleteVersion('v-bob', 'nb-alice'), false, 'foreign version must not delete');
    assert.ok(await exists('notebook_versions', 'v-bob'));
});

test('deleteVersion scoped to notebookId deletes an owned version', async () => {
    assert.strictEqual(await notebookStore.deleteVersion('v-alice', 'nb-alice'), true, 'owned version must be deleted');
    assert.ok(!(await exists('notebook_versions', 'v-alice')));
    assert.ok(await exists('notebook_versions', 'v-bob'));
});
