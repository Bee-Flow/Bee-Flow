// @typecheck
/**
 * The notebook card listing and the side effects of an update, against a real
 * Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * The listing: search input matches literally (`%`, `_` and `\` are escaped
 * and bound) across name, description, the Markdown mirror and source names;
 * sort and filter come from whitelist maps, so anything else falls back to the
 * default and never reaches the SQL; pinned cards come first; limit and offset
 * are clamped. The update: a content write derives preview and word count,
 * bumps the version and marks edit activity; a pin is not content and not
 * recency.
 *
 * Run: cd server && node --test stores/notebookStore.listCards.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const notebookStore = require('./notebookStore');

test.before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        CREATE TABLE notebook_conversations (notebook_id TEXT NOT NULL, user_id TEXT NOT NULL, message_count INT NOT NULL DEFAULT 0)`);
    await notebookStore.initDB();
    // u1's notebooks, each with an activity time an hour apart so the default sort is known.
    await pg.exec(`
        INSERT INTO notebooks (id, user_id, name, description, document_md, type, doc_word_count, last_activity_at, created_at) VALUES
            ('n-sale', 'u1', '50% off', '', '', 'notebook', 0, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '5 days'),
            ('n-pct', 'u1', '50 percent', '', '', 'notebook', 9, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 day'),
            ('n-under', 'u1', 'a_b', 'plain', '', 'notebook', 0, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 days'),
            ('n-axb', 'u1', 'axb', '', 'body mentions back\\slash', 'notebook', 2, NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 days'),
            ('n-desc', 'u1', 'Zeta', 'quarterly figures', '', 'notebook', 0, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '2 days'),
            ('n-arch', 'u1', 'Old', '', '', 'archive', 0, NOW(), NOW()),
            ('n-other', 'u2', '50% off', '', '', 'notebook', 0, NOW(), NOW());
        INSERT INTO notebook_sources (id, notebook_id, type, name, status, word_count) VALUES
            ('s1', 'n-desc', 'text', 'invoice scan', 'ready', 40),
            ('s2', 'n-desc', 'text', 'pending', 'processing', 0);
        INSERT INTO notebook_conversations (notebook_id, user_id, message_count) VALUES ('n-axb', 'u1', 4);
    `);
});
test.after(close);

const ids = async (opts) => (await notebookStore.listNotebookCards('u1', opts)).map((c) => c.id);
const ACTIVITY = ['n-sale', 'n-pct', 'n-under', 'n-axb', 'n-desc'];

// ── listNotebookCards ─────────────────────────────────────────────

test("the listing holds the caller's notebooks of one type, by activity, with counts and no document bodies", async () => {
    const cards = await notebookStore.listNotebookCards('u1', {});
    assert.deepStrictEqual(cards.map((c) => c.id), ACTIVITY, 'u2 and the archive type stay out');
    const desc = cards.find((c) => c.id === 'n-desc');
    assert.deepStrictEqual([desc.sourceCount, desc.processingCount, desc.sourceWordCount], [2, 1, 40]);
    assert.strictEqual(cards.find((c) => c.id === 'n-axb').messageCount, 4);
    for (const c of cards) assert.ok(!('documentContent' in c) && !('documentMd' in c) && !('settings' in c) && !('instructions' in c));
    assert.deepStrictEqual(await ids({ type: 'archive' }), ['n-arch']);
});

test('search: %, _ and \\ match literally', async () => {
    assert.deepStrictEqual(await ids({ search: '50%' }), ['n-sale']);
    assert.deepStrictEqual(await ids({ search: 'a_b' }), ['n-under']);
    assert.deepStrictEqual(await ids({ search: 'back\\slash' }), ['n-axb']);
});

test('search reaches the description, the Markdown mirror and the source names', async () => {
    assert.deepStrictEqual(await ids({ search: 'quarterly' }), ['n-desc']);
    assert.deepStrictEqual(await ids({ search: 'mentions' }), ['n-axb']);
    assert.deepStrictEqual(await ids({ search: 'INVOICE' }), ['n-desc'], 'case-insensitive');
});

test('an unknown sort key falls back to activity and runs nothing it carries', async () => {
    assert.deepStrictEqual(await ids({ sort: 'name; DROP TABLE notebooks;--' }), ACTIVITY);
    assert.ok((await pg.query("SELECT to_regclass('public.notebooks') AS t")).rows[0].t, 'the table is still there');
});

test('whitelisted sorts order by name, creation and words', async () => {
    assert.deepStrictEqual(await ids({ sort: 'name' }), ['n-pct', 'n-sale', 'n-under', 'n-axb', 'n-desc']);
    assert.deepStrictEqual(await ids({ sort: 'created' }), ['n-pct', 'n-desc', 'n-under', 'n-axb', 'n-sale']);
    assert.deepStrictEqual((await ids({ sort: 'words' })).slice(0, 3), ['n-desc', 'n-pct', 'n-axb'], 'document words plus ready source words');
});

test('filters: pinned, sources, chat, empty and processing; an unknown filter is ignored', async () => {
    await pg.query("UPDATE notebooks SET pinned_at = NOW() WHERE id = 'n-axb'");
    try {
        assert.deepStrictEqual(await ids({ filter: 'pinned' }), ['n-axb']);
        assert.deepStrictEqual(await ids({ sort: 'name' }), ['n-axb', 'n-pct', 'n-sale', 'n-under', 'n-desc'], 'pinned always first');
    } finally {
        await pg.query("UPDATE notebooks SET pinned_at = NULL WHERE id = 'n-axb'");
    }
    assert.deepStrictEqual(await ids({ filter: 'sources' }), ['n-desc']);
    assert.deepStrictEqual(await ids({ filter: 'processing' }), ['n-desc']);
    assert.deepStrictEqual(await ids({ filter: 'chat' }), ['n-axb']);
    assert.deepStrictEqual(await ids({ filter: 'empty' }), ['n-sale', 'n-under']);
    assert.deepStrictEqual(await ids({ filter: '1=1; DROP TABLE' }), ACTIVITY);
});

test('limit and offset are clamped', async () => {
    await pg.query(`INSERT INTO notebooks (id, user_id, name) SELECT 'bulk' || g, 'u-bulk', 'B' || g FROM generate_series(1, 205) AS g`);
    assert.strictEqual((await notebookStore.listNotebookCards('u-bulk', { limit: 10000 })).length, notebookStore.MAX_CARD_LIMIT);
    assert.strictEqual(notebookStore.MAX_CARD_LIMIT, 200);
    assert.deepStrictEqual(await ids({ offset: -3 }), ACTIVITY, 'a negative offset is 0');
    assert.deepStrictEqual(await ids({ limit: 2, offset: 1 }), ACTIVITY.slice(1, 3));
});

// ── mapNotebookCardRow ────────────────────────────────────────────

test('mapNotebookCardRow exposes card fields only', () => {
    const mapped = notebookStore.mapNotebookCardRow({
        id: 'n1', name: 'N', description: '', type: 'notebook', version: 3,
        preview: 'p', doc_word_count: '12', pinned_at: '2026-08-01T00:00:00Z',
        last_activity_at: null, last_activity_kind: null,
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
        source_count: '2', processing_count: '1', failed_count: '0',
        source_word_count: '100', message_count: '4',
    });
    assert.strictEqual(mapped.pinned, true);
    assert.strictEqual(mapped.docWordCount, 12);
    assert.strictEqual(mapped.messageCount, 4);
    assert.ok(!('documentContent' in mapped) && !('documentMd' in mapped) && !('settings' in mapped) && !('instructions' in mapped));
});

// ── updateNotebook side effects ───────────────────────────────────

let seq = 0;
async function fresh() {
    seq += 1;
    const id = `nb${seq}`;
    await pg.query("INSERT INTO notebooks (id, user_id, updated_at) VALUES ($1, 'u1', NOW() - INTERVAL '1 day')", [id]);
    return id;
}
const row = async (id) => (await pg.query(
    'SELECT version, preview, doc_word_count, document_content, last_activity_kind, last_activity_at, pinned_at, updated_at FROM notebooks WHERE id = $1', [id],
)).rows[0];

test('an update with nothing in it is a no-op and writes nothing', async () => {
    const id = await fresh();
    const before = await row(id);
    assert.deepStrictEqual(await notebookStore.updateNotebookCas(id, 'u1', {}), { ok: false, conflict: false, noop: true });
    assert.deepStrictEqual(await row(id), before);
});

test('a content write derives preview and word count, bumps the version and marks edit activity', async () => {
    const id = await fresh();
    const before = await row(id);
    const r = await notebookStore.updateNotebookCas(id, 'u1', { documentContent: '<p>Hello world</p><p>Second line</p>' });
    const after = await row(id);
    assert.deepStrictEqual(r, { ok: true, conflict: false, version: before.version + 1 });
    assert.strictEqual(after.preview, 'Hello world\nSecond line');
    assert.strictEqual(after.doc_word_count, 4);
    assert.strictEqual(after.version, before.version + 1);
    assert.strictEqual(after.last_activity_kind, 'edit');
});

test('a Markdown body: the preview comes from the stripped mirror', async () => {
    const id = await fresh();
    await notebookStore.updateNotebook(id, 'u1', { documentContent: '# Title\n\nHello **world**' });
    const after = await row(id);
    assert.strictEqual(after.preview, 'Title Hello world');
    assert.strictEqual(after.doc_word_count, 3);
});

test('HTML content is sanitized before it reaches the row', async () => {
    const id = await fresh();
    await notebookStore.updateNotebook(id, 'u1', { documentContent: '<p>hi</p><script>alert(1)</script>' });
    const { document_content: stored } = await row(id);
    assert.ok(!/script|alert/i.test(stored), 'script must be stripped at the store choke point');
    assert.match(stored, /<p>hi<\/p>/);
});

test('a pin is not content and not recency: no version bump, no activity, no updated_at', async () => {
    const id = await fresh();
    const before = await row(id);
    assert.strictEqual((await notebookStore.updateNotebookCas(id, 'u1', { pinned: true })).ok, true);
    let after = await row(id);
    assert.ok(after.pinned_at);
    assert.strictEqual(after.version, before.version);
    assert.strictEqual(after.last_activity_kind, before.last_activity_kind);
    assert.strictEqual(String(after.updated_at), String(before.updated_at), 'a pin must not read as "just now"');

    await notebookStore.updateNotebookCas(id, 'u1', { pinned: false });
    after = await row(id);
    assert.strictEqual(after.pinned_at, null);
    assert.strictEqual(String(after.updated_at), String(before.updated_at), 'unpin is pin-only too');
});

test('a pin combined with another field still bumps updated_at', async () => {
    const id = await fresh();
    const before = await row(id);
    await notebookStore.updateNotebookCas(id, 'u1', { pinned: true, name: 'Renamed' });
    const after = await row(id);
    assert.ok(after.pinned_at);
    assert.ok(new Date(after.updated_at) > new Date(before.updated_at));
});

// ── touchActivity wiring ──────────────────────────────────────────

test('addSource and deleteSource record source activity', async () => {
    const id = await fresh();
    const s = await notebookStore.addSource({ notebookId: id, type: 'text', name: 'S' });
    assert.strictEqual((await row(id)).last_activity_kind, 'source');
    await pg.query("UPDATE notebooks SET last_activity_kind = NULL WHERE id = $1", [id]);
    await notebookStore.deleteSource(s.id, id);
    assert.strictEqual((await row(id)).last_activity_kind, 'source');
});
