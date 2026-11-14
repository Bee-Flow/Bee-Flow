/**
 * The webpage writes that touch two tables land together or not at all,
 * against a real Postgres (PGlite behind the real db.js): a new extra file or
 * source with the page's updated_at, a deleted extra file with it, and a clone
 * with its extra-file rows.
 *
 * The failure is a trigger: an update of the page named REFUSED, or an
 * extra-file row with the path REFUSED_PATH, raises, after the first write of
 * the old step-by-step code had already run.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/webpage/atomicWrites.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const storageStore = require('../storageStore');
const { initDB } = require('./schema');
const { upsertExtraFile, upsertBinaryExtraFile, deleteExtraFile } = require('./extraFiles');
const { addSource } = require('./sources');
const { cloneWebpage } = require('./webpages');

const REFUSED = 'touch-refused';
const REFUSED_PATH = 'refused.txt';
const realStorage = { isAvailable: storageStore.isAvailable, uploadFile: storageStore.uploadFile, deleteFile: storageStore.deleteFile };

before(async () => {
    await initDB();
    await pg.exec(`
        CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'write refused';
        END $$;
        CREATE TRIGGER refuse_touch BEFORE UPDATE ON webpages
            FOR EACH ROW WHEN (NEW.name = '${REFUSED}') EXECUTE FUNCTION refuse_write();
        CREATE TRIGGER refuse_extra BEFORE INSERT ON webpage_extra_files
            FOR EACH ROW WHEN (NEW.path = '${REFUSED_PATH}') EXECUTE FUNCTION refuse_write();
    `);
    // Bytes go nowhere: the test is about the rows.
    Object.assign(storageStore, { isAvailable: () => true, uploadFile: async () => {}, deleteFile: async () => {} });
});
after(async () => {
    Object.assign(storageStore, realStorage);
    await close();
});

let n = 0;
async function page(name) {
    const id = `wp-${++n}`;
    await pg.query('INSERT INTO webpages (id, user_id, name) VALUES ($1, $2, $3)', [id, 'u1', name]);
    return id;
}
const count = async (sql, params) => Number((await pg.query(sql, params)).rows[0].n);
const extraRows = (webpageId) => count('SELECT COUNT(*)::int AS n FROM webpage_extra_files WHERE webpage_id = $1', [webpageId]);

test('upsertExtraFile: a failing page touch leaves no file row', async () => {
    const id = await page(REFUSED);
    await assert.rejects(() => upsertExtraFile({ webpageId: id, userId: 'u1', path: 'a.txt', content: 'x' }), /write refused/);
    assert.strictEqual(await extraRows(id), 0);
});

test('upsertBinaryExtraFile: a failing page touch leaves no file row', async () => {
    const id = await page(REFUSED);
    await assert.rejects(
        () => upsertBinaryExtraFile({ webpageId: id, userId: 'u1', path: 'a.png', buffer: Buffer.from([1, 2]), mimeType: 'image/png' }),
        /write refused/,
    );
    assert.strictEqual(await extraRows(id), 0);
});

test('upsertExtraFile: the row lands and the page is touched', async () => {
    const id = await page('ok');
    await pg.query(`UPDATE webpages SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [id]);
    const f = await upsertExtraFile({ webpageId: id, userId: 'u1', path: 'b.txt', content: 'x' });
    assert.ok(f.id);
    assert.strictEqual(await extraRows(id), 1);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM webpages WHERE id = $1 AND updated_at > NOW() - INTERVAL '1 hour'`, [id]), 1);
});

test('deleteExtraFile: a failing page touch keeps the file row', async () => {
    const id = await page('ok');
    await upsertExtraFile({ webpageId: id, userId: 'u1', path: 'c.txt', content: 'x' });
    await pg.query(`ALTER TABLE webpages DISABLE TRIGGER refuse_touch`);
    await pg.query('UPDATE webpages SET name = $2 WHERE id = $1', [id, REFUSED]);
    await pg.query(`ALTER TABLE webpages ENABLE TRIGGER refuse_touch`);
    await assert.rejects(() => deleteExtraFile({ webpageId: id, userId: 'u1', path: 'c.txt' }), /write refused/);
    assert.strictEqual(await extraRows(id), 1);
});

test('addSource: a failing page touch leaves no source row', async () => {
    const id = await page(REFUSED);
    await assert.rejects(() => addSource({ webpageId: id, type: 'text', name: 'S' }), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM webpage_sources WHERE webpage_id = $1', [id]), 0);
});

test('cloneWebpage: a failing extra-file copy leaves no cloned page', async () => {
    const id = await page('source');
    await pg.query(`ALTER TABLE webpage_extra_files DISABLE TRIGGER refuse_extra`);
    await pg.query(`INSERT INTO webpage_extra_files (id, webpage_id, path, mime_type, is_text, sha256, size) VALUES ('e1', $1, $2, 'text/plain', true, '', 0)`, [id, REFUSED_PATH]);
    await pg.query(`ALTER TABLE webpage_extra_files ENABLE TRIGGER refuse_extra`);
    await assert.rejects(() => cloneWebpage({ sourceId: id, newOwnerId: 'u2', newName: 'the clone' }), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM webpages WHERE name = 'the clone'`), 0);
});

test('cloneWebpage: the page and its extra-file rows land together', async () => {
    const id = await page('source-ok');
    await upsertExtraFile({ webpageId: id, userId: 'u1', path: 'd.txt', content: 'x' });
    const clone = await cloneWebpage({ sourceId: id, newOwnerId: 'u2', newName: 'good clone' });
    assert.ok(clone?.id);
    assert.strictEqual(await extraRows(clone.id), 1);
});
