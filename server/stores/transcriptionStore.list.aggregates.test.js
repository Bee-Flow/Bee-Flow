/**
 * transcriptionStore — the list-row aggregates the library rail reads
 * (Bee Flow Builder redesign, Sep 2026, Track M1).
 *
 * The rail's meta line says "27 jul · 1:01 · 14 acties open" without the list
 * ever shipping `action_items`; and a failed note's reason is a field of its
 * own instead of a `summary` that is not one. Both are computed in SQL, on
 * BOTH query branches (super admin / normal user), and both must be tolerant
 * of a JSON scalar in `action_items` — the same one-bad-row rule
 * parseJsonArray already enforces on the read side.
 *
 * On a real Postgres: PGlite behind db.js's pool (testUtils/pglitePool.js),
 * the store's own schema, rows inserted as the store would find them.
 *
 * Run: cd server && node --test stores/transcriptionStore.list.aggregates.test.js
 */

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');
before(() => store.initDB());
after(close);
beforeEach(async () => { await pg.exec('DELETE FROM transcriptions'); });

/** @param {string} id @param {Record<string, unknown>} [over] */
const note = (id, over = {}) => insertRow(pg, 'transcriptions', { id, user_id: 'u1', title: id, ...over });
const ITEMS = [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c' }, { text: 'd', done: 'yes' }];

const BRANCHES = [
    { isSuperAdmin: true },
    { orgIds: ['org-1'], userGroupIds: ['g1'] },
    { orgIds: ['org-1'] },
    {},
];

test('getTranscriptions: actionsTotal / actionsOpen are computed on every branch, without shipping action_items', async () => {
    await note('t-1', { action_items: ITEMS, organization_id: 'org-1', is_published: true });
    for (const opts of BRANCHES) {
        const rows = await store.getTranscriptions('u1', opts);
        assert.strictEqual(rows.length, 1, JSON.stringify(opts));
        const [row] = rows;
        assert.strictEqual(row.actionsTotal, 4, `actions_total for ${JSON.stringify(opts)}`);
        assert.strictEqual(row.actionsOpen, 3, `actions_open for ${JSON.stringify(opts)}`);
        // The counts must never ship the array itself.
        assert.ok(!('actionItems' in row) || row.actionItems === undefined, `action_items must not be shipped for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: the aggregates tolerate a non-array action_items and read `done` as text', async () => {
    // A JSON scalar in the column must count as an empty list, not error; a
    // `done` of "yes" is not true — a ::boolean cast would throw and take the
    // whole list down for everyone.
    await note('scalar', { action_items: JSON.stringify('oops'), created_at: '2026-07-01T00:00:00Z' });
    await note('object', { action_items: { a: 1 }, created_at: '2026-07-02T00:00:00Z' });
    await note('items', { action_items: ITEMS, created_at: '2026-07-03T00:00:00Z' });
    const rows = await store.getTranscriptions('u1', { isSuperAdmin: true });
    const by = Object.fromEntries(rows.map(r => [r.id, [r.actionsTotal, r.actionsOpen]]));
    assert.deepStrictEqual(by, { scalar: [0, 0], object: [0, 0], items: [4, 3] });
});

test('getTranscriptions: failureReason is the summary ONLY for failed notes', async () => {
    await note('t-1', { status: 'completed', summary: 'A good meeting.', created_at: '2026-07-03T00:00:00Z' });
    await note('t-2', { status: 'failed', summary: 'Transcription failed: recording empty', created_at: '2026-07-02T00:00:00Z' });
    await note('t-3', { status: 'processing', summary: '', created_at: '2026-07-01T00:00:00Z' });
    const [done, failed, processing] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(done.failureReason, null, 'a completed note has no reason');
    assert.strictEqual(done.summarySnippet, 'A good meeting.');
    assert.strictEqual(failed.failureReason, 'Transcription failed: recording empty');
    assert.strictEqual(processing.failureReason, null);
});

test('getTranscriptions: the summary preview is capped at 400 characters', async () => {
    // Losing the cap would ship every meeting's entire summary on every list row.
    const { SUMMARY_SNIPPET_CHARS } = require('./transcriptCrypto');
    assert.strictEqual(SUMMARY_SNIPPET_CHARS, 400);
    await note('t-1', { status: 'failed', summary: 'x'.repeat(1200) });
    const [row] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(row.summarySnippet.length, 400);
    assert.strictEqual(row.failureReason.length, 400);
});

test('getTranscriptions: the row carries actionsTotal / actionsOpen as numbers and failureReason as a nullable string', async () => {
    await note('t-1', { title: 'Open', status: 'completed', action_items: [{ done: false }, { done: false }, { done: true }], created_at: '2026-07-02T00:00:00Z' });
    await note('t-2', { title: 'Failed', status: 'failed', summary: 'Transcription failed: recording empty', created_at: '2026-07-01T00:00:00Z' });
    const [open, failed] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(open.actionsTotal, 3);
    assert.strictEqual(open.actionsOpen, 2);
    assert.strictEqual(open.failureReason, null);
    assert.strictEqual(failed.actionsTotal, 0);
    assert.strictEqual(failed.actionsOpen, 0);
    assert.strictEqual(failed.failureReason, 'Transcription failed: recording empty');
});

test('the single-note shape, which does not select the aggregates, carries no aggregate keys', async () => {
    // mapRow must not invent a 0 that reads as "no actions" for a note that
    // simply was not asked.
    await note('t-1', { action_items: ITEMS });
    const row = await store.getTranscription('t-1', 'u1');
    assert.ok(row);
    assert.ok(!('actionsTotal' in row));
    assert.ok(!('actionsOpen' in row));
});

test('getTranscriptions: the ACL and limit/offset still hold next to the aggregates', async () => {
    const at = (/** @type {number} */ d) => `2026-07-${String(d).padStart(2, '0')}T00:00:00Z`;
    await note('own', { created_at: at(1) });
    await note('shared', { user_id: 'u2', shared_with: ['u1'], created_at: at(2) });
    await note('org-pub', { user_id: 'u2', is_published: true, organization_id: 'org-1', created_at: at(3) });
    await note('grp-pub', { user_id: 'u2', is_published: true, organization_id: 'org-1', shared_groups: ['g1'], created_at: at(4) });
    await note('grp-other', { user_id: 'u2', is_published: true, organization_id: 'org-1', shared_groups: ['g9'], created_at: at(5) });
    await note('org-unpub', { user_id: 'u2', is_published: false, organization_id: 'org-1', created_at: at(6) });
    await note('other-org', { user_id: 'u2', is_published: true, organization_id: 'org-2', created_at: at(7) });
    const ids = async (/** @type {any} */ opts) => (await store.getTranscriptions('u1', opts)).map(r => r.id).sort();
    assert.deepStrictEqual(await ids({ orgIds: ['org-1'], userGroupIds: ['g1'] }), ['grp-pub', 'org-pub', 'own', 'shared']);
    assert.deepStrictEqual(await ids({ orgIds: ['org-1'] }), ['org-pub', 'own', 'shared']);
    assert.deepStrictEqual(await ids({}), ['own', 'shared']);
    const page = await store.getTranscriptions('u1', { limit: 2, offset: 1, orgIds: ['org-1'], userGroupIds: ['g1'] });
    assert.strictEqual(page.length, 2);
});
