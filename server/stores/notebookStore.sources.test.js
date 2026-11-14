// @typecheck
/**
 * Notebook sources against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js): the list carries no content_text (only whether
 * there is any), a new source takes the next position, an ingestion write can
 * be made conditional on the row still being `processing`, the stuck-source
 * watchdog only touches overdue rows, and a bulk delete keeps to one notebook.
 *
 * Run: cd server && node --test stores/notebookStore.sources.test.js
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
});
test.after(close);

let seq = 0;
async function notebook() {
    seq += 1;
    const id = `n${seq}`;
    await pg.query('INSERT INTO notebooks (id, user_id) VALUES ($1, $2)', [id, 'alice']);
    return id;
}
const statusOf = async (id) => (await pg.query('SELECT status, stage, error FROM notebook_sources WHERE id = $1', [id])).rows[0];

test('getSources and getSource report has_content and never carry the text itself', async () => {
    const nb = await notebook();
    const a = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'A', contentText: 'hello world' });
    const b = await notebookStore.addSource({ notebookId: nb, type: 'url', name: 'B' });
    const rows = await notebookStore.getSources(nb);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.hasContent]), [[a.id, true], [b.id, false]]);
    for (const r of rows) assert.ok(!('contentText' in r) && !('content_text' in r), 'the list never ships the text');
    const one = await notebookStore.getSource(a.id);
    assert.strictEqual(one.hasContent, true);
    assert.ok(!('contentText' in one) && !('content_text' in one));
});

test('getSourceContent is the one getter that returns the text', async () => {
    const nb = await notebook();
    const s = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'X', contentText: 'hello' });
    assert.strictEqual(await notebookStore.getSourceContent(s.id), 'hello');
    assert.strictEqual(await notebookStore.getSourceContent('missing'), null);
});

test('addSource appends: each new source takes the next position, per notebook', async () => {
    const nb = await notebook();
    const other = await notebook();
    const first = await notebookStore.addSource({ notebookId: nb, type: 'text', name: '1' });
    const second = await notebookStore.addSource({ notebookId: nb, type: 'text', name: '2' });
    const elsewhere = await notebookStore.addSource({ notebookId: other, type: 'text', name: 'x' });
    assert.deepStrictEqual([first.sortOrder, second.sortOrder, elsewhere.sortOrder], [1, 2, 1]);
    assert.deepStrictEqual((await notebookStore.getSources(nb)).map((r) => r.name), ['1', '2']);
    await assert.rejects(() => notebookStore.addSource({ notebookId: 'nope', type: 'text' }), (/** @type {any} */ e) => e.status === 404);
});

test('updateSource with onlyIfProcessing writes only while the row is processing; without it, always', async () => {
    const nb = await notebook();
    const s = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'X' });
    await pg.query("UPDATE notebook_sources SET status = 'cancelled' WHERE id = $1", [s.id]);
    assert.strictEqual(await notebookStore.updateSource(s.id, { status: 'ready' }, { onlyIfProcessing: true }), false,
        'a cancel that happened meanwhile wins over the ingestion still running');
    assert.strictEqual((await statusOf(s.id)).status, 'cancelled');
    assert.strictEqual(await notebookStore.updateSource(s.id, { status: 'ready' }), true);
    assert.strictEqual((await statusOf(s.id)).status, 'ready');

    const p = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'Y' });
    assert.strictEqual(await notebookStore.updateSource(p.id, { status: 'ready', wordCount: 4 }, { onlyIfProcessing: true }), true);
    assert.strictEqual((await statusOf(p.id)).status, 'ready');
});

test('timeoutStuckSources flips only overdue processing rows of this notebook', async () => {
    const nb = await notebook();
    const other = await notebook();
    const fresh = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'fresh' });
    assert.strictEqual(await notebookStore.timeoutStuckSources(nb), 0, 'a quiet poll writes nothing');
    const stuck = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'stuck' });
    const stuckElsewhere = await notebookStore.addSource({ notebookId: other, type: 'text', name: 'stuck' });
    await pg.query("UPDATE notebook_sources SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = ANY($1::text[])", [[stuck.id, stuckElsewhere.id]]);

    assert.strictEqual(await notebookStore.timeoutStuckSources(nb), 1);
    assert.deepStrictEqual(await statusOf(stuck.id), { status: 'error', stage: 'error', error: 'Ingestion timed out — retry or re-upload.' });
    assert.strictEqual((await statusOf(fresh.id)).status, 'processing');
    assert.strictEqual((await statusOf(stuckElsewhere.id)).status, 'processing', 'another notebook is left alone');
});

test("deleteSources deletes only this notebook's rows and returns what it removed", async () => {
    const nb = await notebook();
    const other = await notebook();
    const mine = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'mine' });
    const keep = await notebookStore.addSource({ notebookId: nb, type: 'text', name: 'keep' });
    const foreign = await notebookStore.addSource({ notebookId: other, type: 'text', name: 'foreign' });

    const removed = await notebookStore.deleteSources([mine.id, foreign.id, mine.id], nb);
    assert.deepStrictEqual(removed.map((r) => r.id), [mine.id]);
    assert.deepStrictEqual((await notebookStore.getSources(nb)).map((r) => r.id), [keep.id]);
    assert.deepStrictEqual((await notebookStore.getSources(other)).map((r) => r.id), [foreign.id]);
    assert.deepStrictEqual(await notebookStore.deleteSources([foreign.id], nb), []);
    assert.deepStrictEqual(await notebookStore.deleteSources([], nb), []);
});
