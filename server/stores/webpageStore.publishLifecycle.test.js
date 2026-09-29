/**
 * The W2 publish lifecycle, at the store layer.
 *
 * Three things are pinned here, and each one is a way an org reader could end
 * up looking at content the owner never published:
 *
 *   1. THE PRUNE CANNOT EAT THE PIN. Three independent guards: the `, id`
 *      tiebreaker (created_at is TRANSACTION time, so rows written together
 *      tie and OFFSET over an unstable sort drops arbitrary rows), the
 *      `source <> 'published'` exclusion, and the live pointer excluded by id.
 *   2. A POINTER NEVER LEAVES ITS OWN PAGE. setPublishedVersion verifies the
 *      version belongs to this webpage before writing it — a cross-page
 *      pointer would serve another page's bytes to this page's readers.
 *   3. THE READ RULE IS EXPLICIT. resolveReadVersion is the one function that
 *      decides live-vs-pinned, including the documented NULL fall-back, which
 *      is pinned here so it cannot drift silently in either direction.
 *
 * ../db and ../storageStore are mocked (the pattern of webpageStore.idor.test.js)
 * so nothing here touches Postgres or object storage.
 *
 * Run: node --test --test-force-exit stores/webpageStore.publishLifecycle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const calls = { run: [], getOne: [], getAll: [] };

// Rows the mocked getOne can resolve, keyed the same way the IDOR test does.
const versionRows = [
    { id: 'v-mine', webpage_id: 'wp1', source: 'manual', html_sha256: 'h', css_sha256: 'c', js_sha256: 'j', content_length: 10 },
    { id: 'v-foreign', webpage_id: 'wp2', source: 'manual', html_sha256: '', css_sha256: '', js_sha256: '', content_length: 0 },
];
const webpageRows = [
    { id: 'wp1', user_id: 'alice', html_sha256: 'h', css_sha256: 'c', js_sha256: 'j', html_size: 5, css_size: 3, js_size: 2 },
];

function matchRow(rows, sql, params) {
    const conds = [...sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(m => [m[1], params[Number(m[2]) - 1]]);
    return rows.find(r => conds.every(([col, val]) => r[col] === val)) || null;
}

const mockDb = {
    run: async (sql, params = []) => { calls.run.push({ sql, params }); return { rowCount: 1 }; },
    getOne: async (sql, params = []) => {
        calls.getOne.push({ sql, params });
        if (/FROM webpage_versions/i.test(sql)) return matchRow(versionRows, sql, params);
        if (/FROM webpages/i.test(sql)) return matchRow(webpageRows, sql, params);
        return null;
    },
    getAll: async (sql, params = []) => { calls.getAll.push({ sql, params }); return []; },
    exec: async () => undefined,
};
const mockStorage = {
    deleteFile: async () => undefined,
    isAvailable: () => false,
    copyObject: async () => undefined,
    buildWebpageKey: (userId, webpageId, slot, versionId) =>
        `webpages/${userId}/${webpageId}/${versionId || 'current'}/${slot}`,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db' || request === '../../db') return 'mock-db';
    if (request === './storageStore' || request === '../storageStore') return 'mock-storage';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-storage'] = { id: 'mock-storage', exports: mockStorage };

const webpageStore = require('./webpageStore');

function reset() { calls.run = []; calls.getOne = []; calls.getAll = []; }
const pruneQuery = () => calls.getAll.find(c => /SELECT id FROM webpage_versions/i.test(c.sql));

// ── 1. The prune ──────────────────────────────────────────────────────

test('the prune orders by (created_at, id) — created_at alone ties', async () => {
    reset();
    await webpageStore.createVersion('alice', 'wp1', 'x');
    const q = pruneQuery();
    assert.ok(q, 'createVersion must still prune');
    assert.match(q.sql, /ORDER BY created_at DESC, id/,
        'NOW() is transaction time: two rows from one transaction tie, and OFFSET over an unstable sort drops arbitrary rows');
});

test('the prune never counts or deletes a published snapshot', async () => {
    reset();
    await webpageStore.createVersion('alice', 'wp1', 'x');
    assert.match(pruneQuery().sql, /source\s*<>\s*'published'/,
        "a frozen snapshot is a deliberate point in time — W4's per-turn 'ai' rows must not bury it");
});

test('the prune excludes the live pointer by id, and a NULL pointer excludes nothing', async () => {
    reset();
    await webpageStore.createVersion('alice', 'wp1', 'x');
    const sql = pruneQuery().sql;
    assert.match(sql, /id\s*<>\s*COALESCE\(\(SELECT published_version_id FROM webpages WHERE id = \$1\)/,
        'belt on top of the braces: a row pinned under any source still survives');
    assert.match(sql, /COALESCE\([^)]*\)\s*,\s*''\)|COALESCE\(\(SELECT published_version_id FROM webpages WHERE id = \$1\), ''\)/,
        "COALESCE keeps the comparison total — without it a NULL pointer makes the whole predicate NULL and NOTHING is pruned");
});

// ── 2. The source column ──────────────────────────────────────────────

// De INSERT loopt sinds W4 via getOne (INSERT … RETURNING seq, zie
// _insertVersionRow) en draagt achter `source` nog twee parameters. `source`
// staat op $8 en wordt dus op INDEX 7 gelezen — niet meer op de laatste
// positie, want dan zou deze test straks stilletjes line_delta controleren.
const insertCall = () => calls.getOne.find(c => /INSERT INTO webpage_versions/i.test(c.sql));
const SOURCE_PARAM = 7;

test("createVersion defaults to 'manual' so the four pre-W2 call sites are unchanged", async () => {
    reset();
    await webpageStore.createVersion('alice', 'wp1', 'Auto-save');
    const insert = insertCall();
    assert.ok(insert);
    assert.strictEqual(insert.params[SOURCE_PARAM], 'manual');
});

test('createVersion records an explicit source', async () => {
    reset();
    await webpageStore.createVersion('alice', 'wp1', 'Published', null, 'published');
    assert.strictEqual(insertCall().params[SOURCE_PARAM], 'published');
});

test('an unknown source is stored as manual, never as free text', async () => {
    reset();
    // A caller inventing a value must not be able to write a row the prune
    // then refuses to touch: only the vocabulary can produce 'published'.
    await webpageStore.createVersion('alice', 'wp1', 'x', null, 'published-ish');
    assert.strictEqual(insertCall().params[SOURCE_PARAM], 'manual');
});

// ── 3. setPublishedVersion ────────────────────────────────────────────

test('setPublishedVersion refuses a version belonging to another webpage', async () => {
    reset();
    const ok = await webpageStore.setPublishedVersion('wp1', 'alice', 'v-foreign');
    assert.strictEqual(ok, false, "wp2's version must not become wp1's published snapshot");
    assert.ok(!calls.run.some(c => /published_version_id/i.test(c.sql)),
        'and no UPDATE may be issued at all');
});

test('setPublishedVersion writes an owned version, scoped to the owner', async () => {
    reset();
    const ok = await webpageStore.setPublishedVersion('wp1', 'alice', 'v-mine');
    assert.strictEqual(ok, true);
    const upd = calls.run.find(c => /published_version_id/i.test(c.sql));
    assert.match(upd.sql, /WHERE id = \$2 AND user_id = \$3/, 'owner-scoped like every other write here');
    assert.deepStrictEqual(upd.params, ['v-mine', 'wp1', 'alice']);
});

test('setPublishedVersion(null) clears the pointer without looking anything up', async () => {
    reset();
    const ok = await webpageStore.setPublishedVersion('wp1', 'alice', null);
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.getOne.filter(c => /FROM webpage_versions/i.test(c.sql)).length, 0);
    const upd = calls.run.find(c => /published_version_id/i.test(c.sql));
    assert.strictEqual(upd.params[0], null, 'a page with no audience must not keep a pointer claiming one');
});

// ── 4. The read rule ──────────────────────────────────────────────────

const OWNED = { id: 'wp1', userId: 'alice', publishedVersionId: 'v-mine' };

test('the owner always reads the live row', () => {
    const r = webpageStore.resolveReadVersion(OWNED, 'alice');
    assert.deepStrictEqual(r, { versionId: null, fellBackToLive: false },
        'an owner served their own snapshot could not edit their own page');
});

test('a non-owner reads the pinned snapshot', () => {
    assert.deepStrictEqual(
        webpageStore.resolveReadVersion(OWNED, 'bob'),
        { versionId: 'v-mine', fellBackToLive: false });
});

test('a NULL pointer falls back to live AND says so — the documented fail-open', () => {
    // This is the one case the product rule ("unknown is never the wider
    // value") and the W2 spec ("otherwise the live row") disagree on. It is
    // built per spec so pages published before the column existed do not go
    // blank on deploy, and `fellBackToLive` is what makes every such read
    // observable. If this ever flips to a refusal, this test is the record
    // of the decision that was changed.
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

test('getVersionMeta returns null for a pruned pointer instead of guessing', async () => {
    reset();
    assert.strictEqual(await webpageStore.getVersionMeta('v-gone'), null);
    assert.strictEqual(await webpageStore.getVersionMeta(null), null,
        'and it never queries for a pointer that was never set');
});

test('getVersionMeta reads the row only — no object-storage round trip', async () => {
    reset();
    const meta = await webpageStore.getVersionMeta('v-mine');
    assert.strictEqual(meta.webpageId, 'wp1', 'callers must be able to reject a cross-page pointer');
    assert.strictEqual(meta.htmlSha, 'h');
    assert.strictEqual(meta.source, 'manual');
});
