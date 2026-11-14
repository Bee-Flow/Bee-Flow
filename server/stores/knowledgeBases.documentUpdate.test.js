// @typecheck strict
/**
 * knowledgeBases.replaceDocumentContent against a real Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js).
 *
 * The timestamp is the point of this file. This write stamps `updated_at` and
 * hands the row back EVEN FOR AN EMPTY PATCH: the re-ingest path calls it to
 * say "checked, unchanged", and a document whose updated_at stopped moving
 * reads downstream as abandoned. The column names come from the store's map
 * only, and status / pii_status fall back to a safe value.
 *
 * Run: cd server && node --test stores/knowledgeBases.documentUpdate.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../testUtils/pglitePool');

const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const managedParts = require('./managedPartsDefault');
const kb = require('./knowledgeBases');

const { swap, restore } = makeSwaps();

before(async () => {
    // No base here sits in a Solution stage; the stage guard has its own tests.
    swap(managedParts, 'managedInfoForKb', async () => null);
    await kb.initDB();
});
after(async () => { restore(); await close(); });

const KB = '00000000-0000-4000-8000-000000000001';

async function doc() {
    await pg.query(`INSERT INTO knowledge_bases (id, name, tenant_id) VALUES ($1, 'KB', 't1') ON CONFLICT DO NOTHING`, [KB]);
    const { rows } = await pg.query(
        `INSERT INTO documents (id, tenant_id, knowledge_base_id, title, status, updated_at)
         VALUES (gen_random_uuid(), 't1', $1, 'stored title', 'skipped', NOW() - INTERVAL '1 day') RETURNING id`, [KB]);
    return /** @type {string} */ (rows[0].id);
}
const row = async (/** @type {string} */ id) => /** @type {any} */ ((await pg.query(
    'SELECT title, chunk_count, status, pii_status, updated_at FROM documents WHERE id = $1', [id],
)).rows[0]);

test('an empty patch still stamps updated_at and returns the row', async () => {
    const id = await doc();
    const before = await row(id);
    const out = await kb.replaceDocumentContent(id, {});
    assert.strictEqual(out.id, id, 'the caller reads the row back, not undefined');
    assert.ok(new Date((await row(id)).updated_at) > new Date(before.updated_at));
});

test('a patch writes its columns and still stamps updated_at', async () => {
    const id = await doc();
    const before = await row(id);
    await kb.replaceDocumentContent(id, { title: 'nieuw', chunkCount: '7' });
    const after = await row(id);
    assert.strictEqual(after.title, 'nieuw');
    assert.strictEqual(after.chunk_count, 7, 'chunk_count is coerced to an int');
    assert.ok(new Date(after.updated_at) > new Date(before.updated_at));
});

test('a key the store does not know names no column', async () => {
    const id = await doc();
    const before = await row(id);
    await kb.replaceDocumentContent(id, { 'status = \'processed\', tenant_id': 'x' });
    const after = await row(id);
    assert.strictEqual(after.status, before.status, 'an unmapped key is ignored');
    assert.strictEqual(after.title, before.title);
});

test('status and pii_status fall back to their safe value instead of being written through', async () => {
    const id = await doc();
    await kb.replaceDocumentContent(id, { status: 'not-a-status', piiStatus: 'nonsense' });
    const after = await row(id);
    assert.deepStrictEqual([after.status, after.pii_status], ['processed', 'unscanned']);
});

test('the write touches only the document it names', async () => {
    const a = await doc();
    const b = await doc();
    await kb.replaceDocumentContent(a, { title: 'only a' });
    assert.strictEqual((await row(b)).title, 'stored title');
});
