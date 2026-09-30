'use strict';

/**
 * Meeting notes as project content, against a REAL Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js): the
 * store runs its own schema init and SQL, with no module mocking. The project
 * ROLE and the transcript key are fixtures, swapped on the objects the store
 * asks (stores/lib/projectRole.js, stores/transcriptCrypto.js).
 *
 * What a project changes about a meeting note: every member may READ it. What
 * it does not change: every write, the delete included, stays the owner's.
 * Filing is the owner's act into a project of the note's own organisation;
 * taking it out is scoped to one project; a project delete detaches.
 *
 * Run: cd server && node --test stores/transcriptionStore.project.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');
const transcriptCrypto = require('./transcriptCrypto');
const projectRole = require('./lib/projectRole');

const ROLES = {
    p1: { alice: 'owner', bob: 'editor', vic: 'viewer' },
    p2: { alice: 'owner' },
    pOther: { olga: 'owner', alice: 'viewer' },
};

const { swap, restore } = makeSwaps();

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO projects VALUES ('p1','alice','org1'), ('p2','alice','org1'), ('pOther','olga','org2');
    `);
    // Plaintext: this suite is about who may read, not how it is sealed (the
    // crypto has its own suites).
    swap(transcriptCrypto, 'resolveTranscriptCrypto', async () => transcriptCrypto.PLAINTEXT_CONTEXT);
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[projectId]?.[userId] || null);
    await store.initDB();
});

after(async () => {
    restore();
    await close();
});

const note = (userId = 'alice', extra = {}) => store.createTranscription({
    userId, organizationId: 'org1', title: 'Weekly sync', fileName: 'sync.webm',
    fullText: 'the whole transcript', transcript: 'Alice: the whole transcript', summary: 'We agreed.',
    actionItems: [{ id: 'a1', text: 'Ship it', done: false }, { id: 'a2', text: 'Test it', done: true }],
    durationSeconds: 1800, ...extra,
});

// ═══ Filing ══════════════════════════════════════════════════════════

test('the owner files their note into a project of its organisation; nobody else can', async () => {
    const { id } = await note();
    assert.strictEqual(await store.setTranscriptionProject(id, 'bob', 'p1'), false, 'an editor, not the owner');
    assert.strictEqual(await store.setTranscriptionProject(id, 'alice', 'pOther'), false, 'another organisation');
    assert.strictEqual(await store.setTranscriptionProject(id, 'alice', 'missing'), false, 'no such project');
    assert.strictEqual(await store.setTranscriptionProject(id, 'alice', 'p1'), true);
    assert.strictEqual((await store.getTranscription(id, 'alice')).projectId, 'p1');
});

test('filing is not an edit: updated_at does not move', async () => {
    const { id } = await note();
    const before = (await pg.query('SELECT updated_at FROM transcriptions WHERE id = $1', [id])).rows[0].updated_at;
    await store.setTranscriptionProject(id, 'alice', 'p1');
    const afterFiling = (await pg.query('SELECT updated_at FROM transcriptions WHERE id = $1', [id])).rows[0].updated_at;
    assert.strictEqual(new Date(afterFiling).getTime(), new Date(before).getTime());
});

// ═══ Reading ═════════════════════════════════════════════════════════

test('every member reads a filed note; a non-member and a stranger do not', async () => {
    const { id } = await note();
    assert.strictEqual(await store.getTranscription(id, 'vic'), null, 'not filed: the ACL as before');
    assert.strictEqual(await store.canReadTranscription(id, 'vic'), false);
    await store.setTranscriptionProject(id, 'alice', 'p1');

    const asViewer = await store.getTranscription(id, 'vic');
    assert.strictEqual(asViewer.projectRole, 'viewer');
    assert.strictEqual(asViewer.isOwner, false);
    assert.strictEqual(asViewer.summary, 'We agreed.');
    assert.strictEqual(asViewer.projectId, 'p1');
    assert.strictEqual((await store.getTranscription(id, 'bob')).projectRole, 'editor');
    assert.strictEqual(await store.canReadTranscription(id, 'vic'), true, 'the same answer as the read');

    assert.strictEqual(await store.getTranscription(id, 'eve'), null);
    assert.strictEqual(await store.canReadTranscription(id, 'eve'), false);
    assert.strictEqual(await store.getTranscription(id, 'olga'), null);

    const own = await store.getTranscription(id, 'alice');
    assert.strictEqual(own.isOwner, true);
    assert.strictEqual(own.projectRole, undefined, 'the owner reads through ownership');
});

test('writes stay with the owner: a project editor can neither change nor delete the note', async () => {
    const { id } = await note();
    await store.setTranscriptionProject(id, 'alice', 'p1');
    assert.strictEqual(await store.updateTranscription(id, 'bob', { title: 'Hijacked' }), false);
    assert.strictEqual(await store.setPublished(id, 'bob', true, [], 'org1'), false);
    assert.strictEqual(await store.deleteTranscription(id, 'bob'), false);
    const still = await store.getTranscription(id, 'alice');
    assert.strictEqual(still.title, 'Weekly sync');
    assert.strictEqual(still.isPublished, false);
    assert.ok(await store.updateTranscription(id, 'alice', { title: 'Renamed by its owner' }));
});

test('a note taken out of the project is private again', async () => {
    const { id } = await note();
    await store.setTranscriptionProject(id, 'alice', 'p1');
    assert.strictEqual(await store.detachTranscriptionFromProject(id, 'p2', 'alice'), false, 'not in p2');
    assert.strictEqual(await store.detachTranscriptionFromProject(id, 'p1', 'bob'), false, 'not bob\'s');
    assert.strictEqual(await store.detachTranscriptionFromProject(id, 'p1', 'alice'), true);
    assert.strictEqual(await store.getTranscription(id, 'vic'), null);
    // And the project owner's removal, which takes anyone's note out of THEIR project.
    await store.setTranscriptionProject(id, 'alice', 'p1');
    assert.strictEqual(await store.detachTranscriptionFromProject(id, 'p1', null), true);
    assert.ok(await store.getTranscription(id, 'alice'), 'taken out, never deleted');
});

// ═══ Listing, counting, detaching on project delete ══════════════════

test('the project listing is card-shaped and carries no content', async () => {
    const { id } = await note('alice', { projectId: 'p2' });
    const cards = await store.listProjectMeetings('p2');
    const card = cards.find(c => c.id === id);
    assert.deepStrictEqual(Object.keys(card).sort(), [
        'actionItemCount', 'createdAt', 'durationSeconds', 'id', 'projectId', 'status', 'title', 'updatedAt', 'userId',
    ]);
    assert.strictEqual(card.actionItemCount, 2);
    assert.strictEqual(card.durationSeconds, 1800);
    assert.strictEqual(card.userId, 'alice');
    assert.ok(!JSON.stringify(cards).includes('the whole transcript'), 'no transcript text in a listing');
    assert.ok(!JSON.stringify(cards).includes('We agreed'), 'nor the summary');
    assert.deepStrictEqual(await store.listProjectMeetings(null), []);
});

test('created straight into a project, it is counted and a project delete detaches it', async () => {
    const created = await note('alice', { projectId: 'p2' });
    assert.strictEqual(created.projectId, 'p2');
    const counts = await store.countProjectMeetings(['p2', 'pOther', '']);
    assert.ok(counts.get('p2') >= 1);
    assert.strictEqual(counts.has('pOther'), false, 'absent means none');
    assert.deepStrictEqual(await store.countProjectMeetings([]), new Map());

    const cleared = await store.clearProjectFromTranscriptions('p2');
    assert.strictEqual(cleared, counts.get('p2'));
    assert.deepStrictEqual(await store.listProjectMeetings('p2'), []);
    assert.strictEqual((await store.getTranscription(created.id, 'alice')).projectId, null);
});

test('the owner\'s own list says which project a note is in', async () => {
    const { id } = await note();
    await store.setTranscriptionProject(id, 'alice', 'p1');
    const mine = await store.getTranscriptions('alice', { limit: 100 });
    assert.strictEqual(mine.find(t => t.id === id).projectId, 'p1');
    const others = await store.getTranscriptions('vic', { limit: 100 });
    assert.ok(!others.some(t => t.id === id), 'a member\'s personal list is not widened');
});
