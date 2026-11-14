// @typecheck
/**
 * The publish lifecycle at the store layer, against a real Postgres (PGlite
 * behind db.js's pool, testUtils/pglitePool.js). Object storage is not
 * configured, so the version copies are skipped and only the rows move.
 *
 * Each case is a way an org reader could end up looking at content the owner
 * never published:
 *
 *   1. THE PRUNE CANNOT EAT THE PIN. Rows written together tie on created_at
 *      (transaction time), so the prune breaks the tie on id; it never counts a
 *      published snapshot; and it keeps the live pointer by id.
 *   2. A POINTER NEVER LEAVES ITS OWN PAGE. setPublishedVersion refuses a
 *      version of another page.
 *   3. THE READ RULE IS EXPLICIT. resolveReadVersion decides live-vs-pinned,
 *      including the documented NULL fall-back.
 *
 * Run: cd server && node --test stores/webpageStore.publishLifecycle.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const webpageStore = require('./webpageStore');
const { initDB } = require('./webpage/schema');

const MAX = 200;

test.before(async () => {
    await initDB();
    await pg.query(`INSERT INTO webpages (id, user_id, html_sha256, css_sha256, js_sha256, html_size, css_size, js_size)
                    VALUES ('wp1', 'alice', 'h', 'c', 'j', 5, 3, 2), ('wp2', 'bob', '', '', '', 0, 0, 0)`);
    await pg.query(`INSERT INTO webpage_versions (id, webpage_id, summary, html_sha256, css_sha256, js_sha256, content_length, source, seq)
                    VALUES ('v-mine', 'wp1', 'mine', 'h', 'c', 'j', 10, 'manual', 1),
                           ('v-foreign', 'wp2', 'theirs', '', '', '', 0, 'manual', 1)`);
});
test.after(close);

async function versionsOf(webpageId) {
    const { rows } = await pg.query('SELECT id, source, summary FROM webpage_versions WHERE webpage_id = $1', [webpageId]);
    return rows;
}
const pointerOf = async (id) => (await pg.query('SELECT published_version_id FROM webpages WHERE id = $1', [id])).rows[0].published_version_id;

// ── 1. The prune ──────────────────────────────────────────────────────

test('the prune keeps the cap, never a published snapshot or the live pointer, and breaks created_at ties on id', async () => {
    await pg.query("INSERT INTO webpages (id, user_id) VALUES ('wp-prune', 'alice')");
    // Old rows first: a published snapshot and the row the live pointer names.
    await pg.query(`INSERT INTO webpage_versions (id, webpage_id, source, seq, created_at) VALUES
        ('a-published', 'wp-prune', 'published', 1, NOW() - INTERVAL '10 days'),
        ('a-pinned', 'wp-prune', 'ai', 2, NOW() - INTERVAL '10 days')`);
    await pg.query("UPDATE webpages SET published_version_id = 'a-pinned' WHERE id = 'wp-prune'");
    // MAX manual rows that all tie on created_at, written in an order that is not their id order.
    const ids = Array.from({ length: MAX }, (_, i) => `m${String(i).padStart(3, '0')}`);
    const shuffled = ids.map((id, i) => /** @type {[string, number]} */ ([id, (i * 7919) % MAX])).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, source, seq, created_at)
         SELECT v, 'wp-prune', 'manual', 10 + ord, NOW() - INTERVAL '1 day' FROM unnest($1::text[]) WITH ORDINALITY AS t(v, ord)`,
        [shuffled],
    );

    // The new snapshot makes MAX + 1 prunable rows: exactly one goes.
    await webpageStore.createVersion('alice', 'wp-prune', 'x');

    const left = await versionsOf('wp-prune');
    const leftIds = new Set(left.map((r) => r.id));
    assert.ok(leftIds.has('a-published'), "a frozen snapshot is a deliberate point in time and never counts against the cap");
    assert.ok(leftIds.has('a-pinned'), 'the live pointer survives whatever its source');
    assert.strictEqual(left.length, MAX + 2, 'the cap plus the two protected rows');
    // ORDER BY created_at DESC, id: among the tied rows the highest id sorts last and is the one past the cap.
    assert.ok(!leftIds.has('m199'), 'the tie is broken on id, so the dropped row is the same on every run');
    assert.ok(ids.slice(0, MAX - 1).every((id) => leftIds.has(id)));
});

test('a page with no live pointer still prunes', async () => {
    await pg.query("INSERT INTO webpages (id, user_id) VALUES ('wp-null', 'alice')");
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, source, seq, created_at)
         SELECT 'n' || g, 'wp-null', 'manual', g, NOW() - INTERVAL '1 day' - g * INTERVAL '1 second' FROM generate_series(1, $1::int) AS g`,
        [MAX],
    );
    await webpageStore.createVersion('alice', 'wp-null', 'x');
    const left = new Set((await versionsOf('wp-null')).map((r) => r.id));
    // A NULL pointer must exclude nothing, not make the whole predicate NULL.
    assert.strictEqual(left.size, MAX);
    assert.ok(!left.has(`n${MAX}`), 'the oldest row went');
});

// ── 2. The source column ──────────────────────────────────────────────

test("createVersion defaults to 'manual', records an explicit source, and stores anything else as manual", async () => {
    const plain = await webpageStore.createVersion('alice', 'wp1', 'Auto-save');
    const published = await webpageStore.createVersion('alice', 'wp1', 'Published', null, 'published');
    // A caller inventing a value must not be able to write a row the prune then refuses to touch.
    const invented = await webpageStore.createVersion('alice', 'wp1', 'x', null, 'published-ish');
    const rows = new Map((await versionsOf('wp1')).map((r) => [r.id, r]));
    assert.strictEqual(rows.get(plain.id).source, 'manual');
    assert.strictEqual(rows.get(published.id).source, 'published');
    assert.strictEqual(rows.get(invented.id).source, 'manual');
    assert.strictEqual(invented.source, 'manual');
});

test('createVersion copies the hashes and size of the live row into the snapshot', async () => {
    const v = await webpageStore.createVersion('alice', 'wp1', 'snap');
    const meta = await webpageStore.getVersionMeta(v.id);
    assert.deepStrictEqual([meta.htmlSha, meta.cssSha, meta.jsSha, meta.contentLength], ['h', 'c', 'j', 10]);
});

// ── 3. setPublishedVersion ────────────────────────────────────────────

test('setPublishedVersion refuses a version belonging to another webpage', async () => {
    await pg.query("UPDATE webpages SET published_version_id = NULL WHERE id = 'wp1'");
    assert.strictEqual(await webpageStore.setPublishedVersion('wp1', 'alice', 'v-foreign'), false,
        "wp2's version must not become wp1's published snapshot");
    assert.strictEqual(await pointerOf('wp1'), null, 'and nothing was written');
});

test('setPublishedVersion writes an owned version, and only for the owner', async () => {
    assert.strictEqual(await webpageStore.setPublishedVersion('wp1', 'alice', 'v-mine'), true);
    assert.strictEqual(await pointerOf('wp1'), 'v-mine');
    assert.strictEqual(await webpageStore.setPublishedVersion('wp1', 'bob', null), false, 'not the owner');
    assert.strictEqual(await pointerOf('wp1'), 'v-mine');
});

test('setPublishedVersion(null) clears the pointer', async () => {
    await pg.query("UPDATE webpages SET published_version_id = 'v-mine' WHERE id = 'wp1'");
    assert.strictEqual(await webpageStore.setPublishedVersion('wp1', 'alice', null), true);
    assert.strictEqual(await pointerOf('wp1'), null, 'a page with no audience must not keep a pointer claiming one');
});

// ── 4. The read rule ──────────────────────────────────────────────────

const OWNED = { id: 'wp1', userId: 'alice', publishedVersionId: 'v-mine' };

test('the owner always reads the live row', () => {
    assert.deepStrictEqual(webpageStore.resolveReadVersion(OWNED, 'alice'), { versionId: null, fellBackToLive: false },
        'an owner served their own snapshot could not edit their own page');
});

test('a non-owner reads the pinned snapshot', () => {
    assert.deepStrictEqual(webpageStore.resolveReadVersion(OWNED, 'bob'), { versionId: 'v-mine', fellBackToLive: false });
});

test('a NULL pointer falls back to live AND says so — the documented fail-open', () => {
    // Built per spec so pages published before the column existed do not go
    // blank on deploy; `fellBackToLive` makes every such read observable.
    const r = webpageStore.resolveReadVersion({ id: 'wp1', userId: 'alice', publishedVersionId: null }, 'bob');
    assert.deepStrictEqual(r, { versionId: null, fellBackToLive: true });
});

test('an absent row resolves to nothing at all', () => {
    assert.deepStrictEqual(webpageStore.resolveReadVersion(null, 'bob'), { versionId: null, fellBackToLive: false });
    assert.deepStrictEqual(webpageStore.resolveReadVersion(undefined, 'bob'), { versionId: null, fellBackToLive: false });
});

test('an empty-string pointer is treated as no pointer, not as a version id', () => {
    const r = webpageStore.resolveReadVersion({ id: 'wp1', userId: 'alice', publishedVersionId: '' }, 'bob');
    assert.strictEqual(r.versionId, null);
    assert.strictEqual(r.fellBackToLive, true);
});

// ── 5. getVersionMeta ─────────────────────────────────────────────────

test('getVersionMeta returns null for a pruned or never-set pointer', async () => {
    assert.strictEqual(await webpageStore.getVersionMeta('v-gone'), null);
    assert.strictEqual(await webpageStore.getVersionMeta(null), null);
});

test('getVersionMeta reads the row: the page it belongs to, its hashes and its source', async () => {
    const meta = await webpageStore.getVersionMeta('v-mine');
    assert.strictEqual(meta.webpageId, 'wp1', 'callers must be able to reject a cross-page pointer');
    assert.strictEqual(meta.htmlSha, 'h');
    assert.strictEqual(meta.source, 'manual');
});
