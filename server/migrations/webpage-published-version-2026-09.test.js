// @typecheck
/**
 * The W2 publish-lifecycle backfill, on a real Postgres: the boot ladder's
 * schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool
 * (testUtils/pglitePool.js). The store's createVersion copies object-storage
 * blobs, so it is replaced on the store object by one that writes the version
 * row the real one would (and fails for one page).
 *
 * What is held here is the ORDER and the IDEMPOTENCE, because both are the
 * difference between "the audience reads what was published" and a pointer
 * aimed at nothing:
 *
 *   - the columns survive a replay (no migration ledger; every replica
 *     replays this on every boot);
 *   - a snapshot is created for a published page that has none BEFORE any
 *     pointer is written — the pointer cannot aim at a row that does not exist;
 *   - a second run never moves a pointer the owner has since re-published;
 *   - the pointer column has no NOT NULL and no DEFAULT: NULL means
 *     "nothing pinned", not version zero;
 *   - drafts are left alone entirely (no audience, no snapshot work).
 *
 * Run: node --test migrations/webpage-published-version-2026-09.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { hideTable } = require('../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const webpageStore = require('../stores/webpageStore');
const migration = require('./webpage-published-version-2026-09');

/** @type {Array<{ userId: string, webpageId: string, summary: string, source: string }>} */
const snapshots = [];
const realCreateVersion = webpageStore.createVersion;
webpageStore.createVersion = /** @type {any} */ (async (/** @type {string} */ userId, /** @type {string} */ webpageId, /** @type {string} */ summary, /** @type {unknown} */ _hashes, /** @type {string} */ source) => {
    snapshots.push({ userId, webpageId, summary, source });
    if (webpageId === 'wp-broken') throw new Error('blob unreachable');
    return insertRow(pg, 'webpage_versions', { id: `v-${webpageId}`, webpage_id: webpageId, summary, source });
});
// The store's schema is in place before a test hides its table.
test.before(async () => { await webpageStore.ready; });
test.after(async () => { webpageStore.createVersion = realCreateVersion; await close(); });

test.beforeEach(async () => {
    snapshots.length = 0;
    await pg.exec('TRUNCATE webpage_versions, webpages CASCADE');
});

/** @param {string} id @param {Record<string, unknown>} [over] */
const page = (id, over = {}) => insertRow(pg, 'webpages', { id, user_id: 'alice', name: id, is_published: true, ...over });
/** @param {string} id */
const pointer = async (id) => (await pg.query('SELECT published_version_id FROM webpages WHERE id = $1', [id])).rows[0].published_version_id;

test('a build without the webpages table is skipped, not failed', async () => {
    // At boot this ladder is kicked off with setImmediate and is not ordered
    // after the store inits; a light build may have no webpages table at all.
    // "Nothing to pin" is not an error, and it must not ALTER a missing table.
    const show = await hideTable(pg, 'webpages');
    let result;
    try { result = await migration.up(); } finally { await show(); }
    assert.strictEqual(result.skipped, true);
    assert.deepStrictEqual(snapshots, []);
});

test('the columns survive a replay, and the pointer has no NOT NULL and no DEFAULT', async () => {
    await migration.up();
    await migration.up(); // replayed on every boot of every replica
    const { rows } = await pg.query(`SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
        WHERE (table_name, column_name) IN (('webpages', 'published_version_id'), ('webpage_versions', 'source')) ORDER BY table_name`);
    assert.deepStrictEqual(rows, [
        { table_name: 'webpage_versions', column_name: 'source', is_nullable: 'NO', column_default: "'manual'::text" },
        { table_name: 'webpages', column_name: 'published_version_id', is_nullable: 'YES', column_default: null },
    ], 'NULL means "nothing pinned" — a default would read as version zero; existing versions land on manual');
});

test('a published page with no snapshot gets one, and the pointer aims at it', async () => {
    await page('wp1');
    const result = await migration.up();
    assert.deepStrictEqual(snapshots.map(v => [v.webpageId, v.userId, v.source]), [['wp1', 'alice', 'published']],
        "the snapshot is marked 'published' so the prune can never take it");
    assert.strictEqual(await pointer('wp1'), 'v-wp1');
    assert.deepStrictEqual(result, { created: 1, pinned: 1 });
});

test('the pointer picks the newest version, ties broken by id; a pinned pointer never moves', async () => {
    await page('wp-tie');
    const t = '2026-09-01T00:00:00Z';
    await insertRow(pg, 'webpage_versions', { id: 'v-b', webpage_id: 'wp-tie', created_at: t });
    await insertRow(pg, 'webpage_versions', { id: 'v-a', webpage_id: 'wp-tie', created_at: t });
    await insertRow(pg, 'webpage_versions', { id: 'v-old', webpage_id: 'wp-tie', created_at: '2026-08-01T00:00:00Z' });
    await page('wp-pinned', { published_version_id: 'v-p1' });
    await insertRow(pg, 'webpage_versions', { id: 'v-p1', webpage_id: 'wp-pinned', created_at: '2026-01-01T00:00:00Z' });
    await insertRow(pg, 'webpage_versions', { id: 'v-p2', webpage_id: 'wp-pinned', created_at: '2026-10-01T00:00:00Z' });
    await migration.up();
    assert.strictEqual(await pointer('wp-tie'), 'v-a', 'created_at is transaction time — ties need the id tiebreaker');
    assert.strictEqual(await pointer('wp-pinned'), 'v-p1', 're-running must never move a pointer the owner has since re-published');
    assert.deepStrictEqual(snapshots, [], 'pages with versions need no snapshot');
});

test('a page whose snapshot fails keeps a NULL pointer instead of a broken one', async () => {
    await page('wp-broken');
    await page('wp-ok');
    const result = await migration.up();
    assert.strictEqual(result.created, 1, 'the reachable page is still snapshotted');
    assert.strictEqual(snapshots.length, 2, 'and the failure does not abort the loop');
    assert.strictEqual(await pointer('wp-broken'), null);
    assert.strictEqual(await pointer('wp-ok'), 'v-wp-ok');
});

test('drafts are never even looked at', async () => {
    await page('draft', { is_published: false });
    await page('draft-with-version', { is_published: false });
    await insertRow(pg, 'webpage_versions', { id: 'v-d', webpage_id: 'draft-with-version' });
    await migration.up();
    assert.deepStrictEqual(snapshots, [], 'scanning every draft would copy object-storage blobs nobody reads');
    assert.strictEqual(await pointer('draft'), null);
    assert.strictEqual(await pointer('draft-with-version'), null, 'a draft has no audience and needs no pin');
});
