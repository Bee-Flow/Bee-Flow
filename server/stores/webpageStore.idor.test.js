// @typecheck
/**
 * Webpage store cross-tenant IDOR regression tests, against a real Postgres
 * (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * deleteVersion / deleteSource are scoped to the webpage in the URL, so a
 * foreign version or source id cannot be removed (and its blob purged) through
 * a webpage the caller happens to own. See the DELETE /:id/versions/:vid and
 * DELETE /:id/sources/:sid routes, which pass the URL's webpageId through.
 *
 * Run: cd server && node --test stores/webpageStore.idor.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const webpageStore = require('./webpageStore');
const { initDB } = require('./webpage/schema');

test.before(async () => {
    await initDB();
    await pg.exec(`
        INSERT INTO webpages (id, user_id) VALUES ('wp-alice', 'alice'), ('wp-bob', 'bob');
        INSERT INTO webpage_versions (id, webpage_id, summary, content_length) VALUES
            ('v-alice', 'wp-alice', 'x', 1), ('v-bob', 'wp-bob', 'y', 1);
        INSERT INTO webpage_sources (id, webpage_id, type, status, storage_key) VALUES
            ('s-alice', 'wp-alice', 'url', 'ready', NULL), ('s-bob', 'wp-bob', 'url', 'ready', 'bob/blob');
    `);
});
test.after(close);

const exists = async (table, id) => (await pg.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length === 1;

// ── deleteVersion ─────────────────────────────────────────────────

test('deleteVersion scoped to webpageId refuses a foreign version', async () => {
    // Alice owns wp-alice; she passes Bob's version id v-bob under her webpage.
    assert.strictEqual(await webpageStore.deleteVersion('alice', 'v-bob', 'wp-alice'), false, 'foreign version must not delete');
    assert.ok(await exists('webpage_versions', 'v-bob'), "Bob's version is still there");
});

test('deleteVersion scoped to webpageId deletes an owned version', async () => {
    assert.strictEqual(await webpageStore.deleteVersion('alice', 'v-alice', 'wp-alice'), true);
    assert.ok(!(await exists('webpage_versions', 'v-alice')));
    assert.ok(await exists('webpage_versions', 'v-bob'), 'and only that one');
});

// ── deleteSource ──────────────────────────────────────────────────

test('deleteSource scoped to webpageId refuses a foreign source', async () => {
    assert.strictEqual(await webpageStore.deleteSource('s-bob', 'wp-alice'), null, 'foreign source must not delete');
    assert.ok(await exists('webpage_sources', 's-bob'), "Bob's source is still there");
});

test('deleteSource scoped to webpageId deletes an owned source', async () => {
    const src = await webpageStore.deleteSource('s-alice', 'wp-alice');
    assert.ok(src && src.id === 's-alice');
    assert.ok(!(await exists('webpage_sources', 's-alice')));
    assert.ok(await exists('webpage_sources', 's-bob'), 'and only that one');
});
