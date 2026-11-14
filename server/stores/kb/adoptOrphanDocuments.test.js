// @typecheck
/**
 * adoptOrphanDocuments: documents that predate the source model
 * (source_id IS NULL) get a source, scoped to ONE knowledge base, against a
 * real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js, with the
 * knowledge-base store's own schema). The managed-parts lookup is injected.
 *
 * Run: cd server && node --test stores/kb/adoptOrphanDocuments.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const db = require('../../db');
const kb = require('../knowledgeBases');

/** @type {any} */
let managed = null;
const { adoptOrphanDocuments } = require('./adoptOrphanDocuments')(async () => {}, {
    getOne: db.getOne,
    withTransaction: db.withTransaction,
    managedParts: { managedInfoForKb: async () => managed },
});

const KB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test.before(async () => {
    await kb.initDB();
    await pg.query(`INSERT INTO knowledge_bases (id, name, tenant_id) VALUES ($1, 'KB', 'owner1'), ($2, 'Other', 'owner2')`, [KB, OTHER]);
});
test.after(close);
test.beforeEach(async () => {
    managed = null;
    await pg.exec('DELETE FROM documents; DELETE FROM kb_sources');
});

async function doc(kbId, title, sourceType, sourceUri) {
    const { rows } = await pg.query(
        `INSERT INTO documents (id, tenant_id, knowledge_base_id, title, source_type, source_uri, status)
         VALUES (gen_random_uuid(), 't1', $1, $2, $3, $4, 'processed') RETURNING id`,
        [kbId, title, sourceType, sourceUri],
    );
    return rows[0].id;
}
const sourceOf = async (id) => (await pg.query('SELECT source_id FROM documents WHERE id = $1', [id])).rows[0].source_id;
const sources = async (kbId) => (await pg.query('SELECT id, kind, name, created_by FROM kb_sources WHERE knowledge_base_id = $1 ORDER BY created_at', [kbId])).rows;

test('nothing to adopt: nothing is written', async () => {
    assert.strictEqual(await adoptOrphanDocuments(KB), 0);
    assert.deepStrictEqual(await sources(KB), []);
});

test('a legacy upload document gets the KB upload source, created by the base owner', async () => {
    const id = await doc(KB, 'Handbook.pdf', 'upload', 'Handbook.pdf');
    assert.strictEqual(await adoptOrphanDocuments(KB), 1);
    const [src] = await sources(KB);
    assert.deepStrictEqual([src.kind, src.name, src.created_by], ['upload', 'Uploaded files', 'owner1']);
    assert.strictEqual(await sourceOf(id), src.id);
});

test('an existing source with the same key is reused, not duplicated; a second run adopts nothing', async () => {
    const first = await doc(KB, 'a', 'upload', 'a');
    await adoptOrphanDocuments(KB);
    const second = await doc(KB, 'b', 'upload', 'b');
    assert.strictEqual(await adoptOrphanDocuments(KB), 1);
    const all = await sources(KB);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(await sourceOf(second), await sourceOf(first));
    assert.strictEqual(await adoptOrphanDocuments(KB), 0, 'idempotent');
});

test('only this base, and only its unassigned rows, are touched', async () => {
    const mine = await doc(KB, 'a', 'text', null);
    const theirs = await doc(OTHER, 'b', 'text', null);
    await pg.query(`INSERT INTO kb_sources (id, knowledge_base_id, kind, name, config, refresh_mode) VALUES ('33333333-3333-4333-8333-333333333333', $1, 'upload', 'Mine already', '{}'::jsonb, 'manual')`, [KB]);
    const assigned = await doc(KB, 'c', 'upload', 'c');
    await pg.query(`UPDATE documents SET source_id = '33333333-3333-4333-8333-333333333333' WHERE id = $1`, [assigned]);

    assert.strictEqual(await adoptOrphanDocuments(KB), 1);
    assert.ok(await sourceOf(mine));
    assert.strictEqual(await sourceOf(theirs), null, 'another base is left alone');
    assert.strictEqual(await sourceOf(assigned), '33333333-3333-4333-8333-333333333333', 'an assigned row keeps its source');
    assert.deepStrictEqual(await sources(OTHER), []);
});

test('a missing KB id adopts nothing', async () => {
    await doc(KB, 'a', 'upload', 'a');
    assert.strictEqual(await adoptOrphanDocuments(''), 0);
    assert.deepStrictEqual(await sources(KB), []);
});

test('a managed (Solution stage) base is never adopted into, shell mode included', async () => {
    const id = await doc(KB, 'a', 'upload', 'a');
    managed = { stageId: 'st1', mode: 'shell' };
    assert.strictEqual(await adoptOrphanDocuments(KB), 0);
    assert.strictEqual(await sourceOf(id), null);
    assert.deepStrictEqual(await sources(KB), []);
});
