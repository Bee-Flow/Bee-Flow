'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { selectPrunable } = require('../core/versioning/retention');
const { usePglitePool } = require('../testUtils/pglitePool');

/**
 * Version thinning of a Studio document (stores/documentHistory.js
 * pruneVersions) against a REAL Postgres (pglite behind db.js's pool), with
 * the real autosave sessions of stores/documentVersions.js and the shared
 * policy of core/versioning/retention.js.
 *
 * Pinned: a row folded into a later save of its session (`superseded_by`) is
 * not listed, so it never holds an hour's place in the thinned history. When
 * a session crosses an hour boundary after an earlier session ended in that
 * same hour, the hour keeps the earlier session's LISTED state, and the folded
 * rows past the keep-all window go (unless something points at one).
 *
 * Run: cd server && node --test stores/documentHistory.test.js
 */

const { pg, close } = usePglitePool();
const store = require('./documentStore');

const H = 60 * 60 * 1000;

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO users VALUES ('ann','org1');
    `);
    await store.initDB();
});

after(close);

const setTime = (id, at) => pg.query('UPDATE studio_document_versions SET created_at = $2 WHERE id = $1', [id, new Date(at).toISOString()]);
/** End the open autosave session: its newest save is now older than the session gap. */
const endSession = (id) => pg.query(`UPDATE studio_document_versions SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [id]);
const listed = async (docId) => (await store.listVersions(docId, 'ann', { limit: 100 })).versions.map((v) => v.id);
const stored = async (docId) => (await pg.query('SELECT id FROM studio_document_versions WHERE document_id = $1', [docId])).rows.map((r) => r.id);

/**
 * Three days back: session A saves at 10:02, 10:10, 10:20 (only the last is
 * listed); session B saves at 10:30, 10:45, 10:58, 11:05 and 11:14 (only the
 * last is listed); then a fresh save today, the current revision.
 */
async function twoSessionsInOneHour() {
    const doc = await store.createDocument({ userId: 'ann', name: 'Plan', bodyHtml: '<p>zero</p>', settings: { houseStyle: false } });
    let versionId = doc.versionId;
    const save = async (text) => {
        versionId = (await store.updateDocument(doc.id, 'ann', { bodyHtml: `<p>${text}</p>`, expectedVersionId: versionId })).versionId;
        return versionId;
    };
    const a = [await save('a1'), await save('a2'), await save('a3')];
    await endSession(a[2]);
    const b = [await save('b1'), await save('b2'), await save('b3'), await save('b4'), await save('b5')];
    await endSession(b[4]);
    const head = await save('today');

    const hourStart = Math.floor((Date.now() - 3 * 24 * H) / H) * H;
    const minute = (m) => hourStart + m * 60_000;
    await setTime(doc.versionId, minute(-30));
    for (const [id, m] of [[a[0], 2], [a[1], 10], [a[2], 20], [b[0], 30], [b[1], 45], [b[2], 58], [b[3], 65], [b[4], 74]]) await setTime(id, minute(m));
    return { doc, a, b, head };
}

test('the sessions fold as the scenario needs: one listed row per session', async () => {
    const { doc, a, b, head } = await twoSessionsInOneHour();
    assert.deepStrictEqual(await listed(doc.id), [head, b[4], a[2], doc.versionId]);
});

test('thinning keeps the listed state of an hour, never a folded row in its place', async () => {
    const { doc, a, b, head } = await twoSessionsInOneHour();
    const removed = await store.pruneVersions(doc.id, { selectPrunable });
    assert.strictEqual(removed, 6, 'the six folded rows, all older than 48 hours');
    assert.deepStrictEqual((await stored(doc.id)).sort(), [doc.versionId, a[2], b[4], head].sort());
    assert.deepStrictEqual(await listed(doc.id), [head, b[4], a[2], doc.versionId],
        'the 10:00 hour still shows the state session A ended with');
    assert.strictEqual((await store.getDocumentVersion(doc.id, 'ann', a[2])).bodyHtml, '<p>a3</p>', 'and it can be restored');
    assert.strictEqual(await store.pruneVersions(doc.id, { selectPrunable }), 0, 'stable');
});

test('a folded row something points at stays, readable by its id', async () => {
    const { doc, a, b } = await twoSessionsInOneHour();
    await store.pruneVersions(doc.id, { selectPrunable, referencedIds: [b[1]] });
    const left = await stored(doc.id);
    assert.ok(left.includes(b[1]), 'the referenced folded row stays');
    assert.ok(left.includes(a[2]), 'and so does the listed state of its hour');
    assert.strictEqual((await store.getDocumentVersion(doc.id, 'ann', b[1])).bodyHtml, '<p>b2</p>');
});

// ═══ Live co-editing: the stored body has ONE writer ═══════════════════

test('a checkpoint of an older live state never writes the stored body back over a newer mirror', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'Live', docType: 'page', settings: { houseStyle: false } });
    // The job loaded the page at seq 10; meanwhile an AI edit on another
    // replica appended seq 11, materialised it and recorded its version.
    await store.writeCollabBody(page.id, { html: '<p>s10</p>' });
    await store.writeCollabBody(page.id, { html: '<p>s11</p>' });
    const ai = await store.recordVersion(page.id, { html: '<p>s11</p>', source: 'ai', contributors: [{ userId: 'ann', kind: 'ai' }] });
    // The job's checkpoint of seq 10 lands last.
    const late = await store.recordVersion(page.id, { html: '<p>s10</p>', source: 'checkpoint', contributors: [{ userId: 'ann', kind: 'user' }] });
    assert.ok(ai.versionId && late.versionId);

    const doc = await store.getDocument(page.id, 'ann');
    assert.strictEqual(doc.bodyHtml, '<p>s11</p>', 'the body stays the newest mirror: exports, search and mobile keep the AI edit');
    const kept = await store.getDocumentVersion(page.id, 'ann', late.versionId);
    assert.strictEqual(kept.bodyHtml, '<p>s10</p>', 'the version holds the state it was made from');
    assert.strictEqual((await store.getDocumentVersion(page.id, 'ann', ai.versionId)).bodyHtml, '<p>s11</p>');
});

test('a body a live page refused is kept as a conflict version: listed, never current, never the body', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'Live', docType: 'page', bodyHtml: '<p>live</p>', settings: { houseStyle: false } });
    const id = await store.keepConflictCopy(page.id, 'ann', '<p>typed outside the session</p><script>x</script>');
    assert.ok(id);
    const doc = await store.getDocument(page.id, 'ann');
    assert.strictEqual(doc.versionId, page.versionId, 'the current revision is unchanged');
    assert.strictEqual(doc.bodyHtml, '<p>live</p>');
    const copy = await store.getDocumentVersion(page.id, 'ann', id);
    assert.strictEqual(copy.bodyHtml, '<p>typed outside the session</p>', 'kept, sanitised like every page body');
    const listed = (await store.listVersions(page.id, 'ann')).versions;
    assert.deepStrictEqual(listed.map((v) => [v.id, v.source]), [[id, 'conflict'], [page.versionId, 'created']]);
    assert.strictEqual(await store.keepConflictCopy(page.id, 'nobody', '<p>x</p>'), null, 'only someone who may write it');
});
