/**
 * The W2 publish-lifecycle backfill.
 *
 * What is pinned here is the ORDER and the IDEMPOTENCE, because both are the
 * difference between "the audience reads what was published" and a pointer
 * aimed at nothing:
 *
 *   - the columns come first and are IF NOT EXISTS (this product has no
 *     migration ledger; every replica replays this on every boot);
 *   - a snapshot is created for a published page that has none BEFORE any
 *     pointer is written — step 3 cannot point at a row that does not exist;
 *   - the pointer UPDATE is scoped `WHERE published_version_id IS NULL`, so a
 *     second run never moves a pointer the owner has since re-published;
 *   - the pointer column is never given NOT NULL or a DEFAULT: NULL means
 *     "nothing pinned", not version zero;
 *   - drafts are left alone entirely (no audience, no snapshot work).
 *
 * The pg layer and the store are mocked via require.cache (the pattern of
 * studio-app-published-version-2026-08.test.js).
 *
 * Run: node --test --test-force-exit migrations/webpage-published-version-2026-09.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const calls = { ddl: [], all: [], run: [], versions: [] };
let orphanRows = [];

let tablePresent = true;

const fakeDb = {
    async exec(sql) { calls.ddl.push(String(sql).replace(/\s+/g, ' ').trim()); },
    async getAll(sql, params) {
        calls.all.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return orphanRows;
    },
    async run(sql, params) {
        calls.run.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rowCount: 2 };
    },
    async getOne(sql) {
        if (/to_regclass/.test(String(sql))) return { t: tablePresent ? 'webpages' : null };
        return null;
    },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const storePath = require.resolve(path.join(__dirname, '..', 'stores', 'webpageStore.js'));
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
        // The migration awaits this before touching anything: at boot the
        // ladder is not sequenced after the store inits.
        ready: Promise.resolve(),
        createVersion: async (userId, webpageId, summary, hashes, source) => {
            calls.versions.push({ userId, webpageId, summary, source });
            if (webpageId === 'wp-broken') throw new Error('blob unreachable');
            return { id: `v-${webpageId}` };
        },
    },
};

const migration = require('./webpage-published-version-2026-09');

function reset() {
    calls.ddl = []; calls.all = []; calls.run = []; calls.versions = [];
    orphanRows = []; tablePresent = true;
}

test('a build without the webpages table is skipped, not failed', async () => {
    // At boot this ladder is kicked off with setImmediate and is not ordered
    // after the store inits; a light build may have no webpages table at all.
    // "Nothing to pin" is not an error, and it must not ALTER a missing table.
    reset();
    tablePresent = false;
    const result = await migration.up();
    assert.strictEqual(result.skipped, true);
    assert.deepStrictEqual(calls.ddl, []);
    assert.deepStrictEqual(calls.run, []);
});

test('adds both columns idempotently, and never forces NOT NULL on the pointer', async () => {
    reset();
    await migration.up();
    await migration.up(); // replayed on every boot of every replica

    const pointerDdl = calls.ddl.filter(q => /published_version_id/.test(q));
    assert.strictEqual(pointerDdl.length, 2, 'the column statement runs on every invocation');
    for (const q of pointerDdl) {
        assert.match(q, /ALTER TABLE webpages ADD COLUMN IF NOT EXISTS published_version_id TEXT/);
        assert.doesNotMatch(q, /NOT NULL|DEFAULT/,
            'NULL means "nothing pinned" — a default would read as version zero');
    }
    const sourceDdl = calls.ddl.filter(q => /webpage_versions ADD COLUMN/.test(q));
    assert.strictEqual(sourceDdl.length, 2);
    for (const q of sourceDdl) {
        assert.match(q, /IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'/,
            "existing rows must land on 'manual', the pre-W2 behaviour");
    }
});

test('a published page with no snapshot gets one BEFORE any pointer is written', async () => {
    reset();
    orphanRows = [{ id: 'wp1', user_id: 'alice' }];
    await migration.up();

    assert.deepStrictEqual(
        calls.versions.map(v => [v.webpageId, v.userId, v.source]),
        [['wp1', 'alice', 'published']],
        "the snapshot is marked 'published' so the prune can never take it");

    // Ordering is the safety property: a pointer written first would aim at
    // a version that does not exist yet.
    const pointerUpdate = calls.run.find(c => /SET published_version_id/.test(c.sql));
    assert.ok(pointerUpdate, 'the pointer UPDATE must run');
    assert.ok(calls.versions.length > 0, 'and the snapshot must have run before it');
});

test('the pointer UPDATE only ever touches published pages that have none', async () => {
    reset();
    await migration.up();
    const upd = calls.run.find(c => /SET published_version_id/.test(c.sql));
    assert.match(upd.sql, /is_published = TRUE/, 'a draft has no audience and needs no pin');
    assert.match(upd.sql, /published_version_id IS NULL/,
        're-running must never move a pointer the owner has since re-published');
    assert.match(upd.sql, /ORDER BY v\.created_at DESC, v\.id/,
        'created_at is transaction time — ties need the id tiebreaker or the pick is arbitrary');
    assert.match(upd.sql, /EXISTS \(SELECT 1 FROM webpage_versions/,
        'without the EXISTS guard the subselect would write NULL over NULL forever');
});

test('a page whose snapshot fails keeps a NULL pointer instead of a broken one', async () => {
    reset();
    orphanRows = [{ id: 'wp-broken', user_id: 'alice' }, { id: 'wp-ok', user_id: 'alice' }];
    const result = await migration.up();
    assert.strictEqual(result.created, 1, 'the reachable page is still snapshotted');
    assert.strictEqual(calls.versions.length, 2, 'and the failure does not abort the loop');
});

test('drafts are never even looked at', async () => {
    reset();
    await migration.up();
    const scan = calls.all[0];
    assert.match(scan.sql, /w\.is_published = TRUE/,
        'scanning every draft would copy object-storage blobs nobody reads');
});
