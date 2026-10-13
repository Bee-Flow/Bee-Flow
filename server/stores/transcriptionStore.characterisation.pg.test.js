'use strict';

/**
 * transcriptionStore — the golden behaviour of its main paths, against a REAL
 * Postgres (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js).
 *
 * Written before the store was split into stores/transcription/*, to pin what
 * a caller sees: the exported surface, who may read a note through each of
 * the read paths (owner, legacy share, org publish, group publish, project
 * membership, stranger, super admin), and the lifecycle writes (claim, finish,
 * reaper, publish, delete). The paths must agree with each other: "readable"
 * (canReadTranscription) and "actually returned" (getTranscription) may never
 * disagree.
 *
 * Run: cd server && node --test stores/transcriptionStore.characterisation.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');
const transcriptCrypto = require('./transcriptCrypto');
const projectRole = require('./lib/projectRole');

const ROLES = { p1: { alice: 'owner', pete: 'viewer' } };
const { swap, restore } = makeSwaps();

const ids = {};

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO projects VALUES ('p1','alice','org1');
    `);
    swap(transcriptCrypto, 'resolveTranscriptCrypto', async () => transcriptCrypto.PLAINTEXT_CONTEXT);
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[projectId]?.[userId] || null);
    await store.initDB();

    const make = (extra) => store.createTranscription({
        userId: 'alice', organizationId: 'org1', title: 'Weekly sync', fileName: 'sync.webm',
        fullText: 'the whole transcript', summary: 'We agreed.', tags: ['sales'],
        actionItems: [{ id: 'a1', text: 'Ship it', done: false }, { id: 'a2', text: 'Test it', done: true }],
        ...extra,
    });
    ids.priv = (await make({ title: 'Private' })).id;
    ids.shared = (await make({ title: 'Shared', sharedWith: ['sam'] })).id;
    ids.org = (await make({ title: 'Org' })).id;
    await store.setPublished(ids.org, 'alice', true, []);
    ids.group = (await make({ title: 'Group' })).id;
    await store.setPublished(ids.group, 'alice', true, ['g1']);
    ids.proj = (await make({ title: 'Project' })).id;
    assert.strictEqual(await store.setTranscriptionProject(ids.proj, 'alice', 'p1', ['org1']), true);
});

after(async () => {
    restore();
    await close();
});

// Readers and what they may open.
const READERS = {
    owner: ['alice', {}],
    sharee: ['sam', {}],
    orgMember: ['olivia', { orgIds: ['org1'] }],
    groupMember: ['gina', { orgIds: ['org1'], userGroupIds: ['g1'] }],
    projectViewer: ['pete', {}],
    stranger: ['zed', { orgIds: ['org2'], userGroupIds: ['g1'] }],
};
const EXPECTED = {
    owner: ['Group', 'Org', 'Private', 'Project', 'Shared'],
    sharee: ['Shared'],
    orgMember: ['Org'],
    groupMember: ['Group', 'Org'],
    projectViewer: ['Project'],
    stranger: [],
};

test('the exported surface is exactly this', () => {
    assert.deepStrictEqual(Object.keys(store), [
        'createTranscription', 'getTranscriptions', 'getTranscription', 'listByTag',
        'canReadTranscription', 'getTranscriptionsByAudioPaths', 'getTranscriptionBySourceUri',
        'getTranscriptionByTalkRoomToken', 'getTranscriptionByMeetMeetingCode', 'getSeriesPrevious',
        'updateTranscription', 'claimForProcessing', 'finishProcessing', 'timeoutStuckTranscriptions',
        'setPublished', 'deleteTranscription', 'setTranscriptionProject', 'detachTranscriptionFromProject',
        'listProjectMeetings', 'countProjectMeetings', 'clearProjectFromTranscriptions', 'initDB',
    ]);
    for (const k of Object.keys(store)) assert.strictEqual(typeof store[k], 'function', k);
});

test('getTranscription and canReadTranscription agree, reader by reader', async () => {
    for (const [who, [userId, ctx]] of Object.entries(READERS)) {
        const opened = [];
        for (const id of Object.values(ids)) {
            const note = await store.getTranscription(id, userId, ctx);
            const can = await store.canReadTranscription(id, userId, ctx);
            assert.strictEqual(!!note, can, `${who} on ${id}: readable and returned disagree`);
            if (note) opened.push(note.title);
        }
        assert.deepStrictEqual(opened.sort(), EXPECTED[who], who);
    }
});

test('the detail shape: ownership, project role, content and read_at', async () => {
    const own = await store.getTranscription(ids.proj, 'alice');
    assert.strictEqual(own.isOwner, true);
    assert.strictEqual(own.ownerId, 'alice');
    assert.strictEqual(own.projectRole, undefined);
    assert.strictEqual(own.fullText, 'the whole transcript');
    assert.strictEqual(own.summary, 'We agreed.');
    assert.strictEqual(own.projectId, 'p1');
    assert.match(own.readAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert.deepStrictEqual(own.tags, ['sales']);
    assert.strictEqual(own.actionItems.length, 2);

    const viewer = await store.getTranscription(ids.proj, 'pete');
    assert.strictEqual(viewer.isOwner, false);
    assert.strictEqual(viewer.projectRole, 'viewer');

    const admin = await store.getTranscription(ids.priv, 'root', { isSuperAdmin: true });
    assert.strictEqual(admin.title, 'Private');
    assert.strictEqual(admin.isOwner, false);
    assert.strictEqual(await store.canReadTranscription(ids.priv, 'root', { isSuperAdmin: true }), true);
    assert.strictEqual(await store.canReadTranscription('', 'alice'), false);
    assert.strictEqual(await store.getTranscription('nope', 'alice'), null);
});

test('the list applies the ACL without the project path; super admins see all', async () => {
    const titles = async (userId, ctx) => (await store.getTranscriptions(userId, ctx)).map(r => r.title).sort();
    assert.deepStrictEqual(await titles('alice', {}), EXPECTED.owner);
    assert.deepStrictEqual(await titles('sam', {}), ['Shared']);
    assert.deepStrictEqual(await titles('olivia', { orgIds: ['org1'] }), ['Org']);
    assert.deepStrictEqual(await titles('gina', { orgIds: ['org1'], userGroupIds: ['g1'] }), ['Group', 'Org']);
    assert.deepStrictEqual(await titles('pete', {}), [], 'a project member reads one by one, not in the library');
    assert.deepStrictEqual(await titles('root', { isSuperAdmin: true }), EXPECTED.owner);

    const [row] = (await store.getTranscriptions('alice', { limit: 1 }));
    assert.strictEqual(row.isOwner, true);
    assert.strictEqual(row.actionsTotal, 2);
    assert.strictEqual(row.actionsOpen, 1);
    assert.strictEqual(row.transcriptSnippet, 'the whole transcript');
    assert.strictEqual(row.summarySnippet, 'We agreed.');
    assert.strictEqual(row.failureReason, null);
});

test('listByTag applies the same read rule, with the reader as the KB owner', async () => {
    const titles = async (tag, reader, ctx) => (await store.listByTag(tag, reader, ctx)).map(r => r.title).sort();
    assert.deepStrictEqual(await titles('sales', 'alice'), EXPECTED.owner);
    assert.deepStrictEqual(await titles('sales', 'gina', { orgIds: ['org1'], userGroupIds: ['g1'] }), ['Group', 'Org']);
    assert.deepStrictEqual(await titles('sales', 'zed', { orgIds: ['org2'] }), []);
    assert.deepStrictEqual(await titles('other', 'alice'), []);
    assert.deepStrictEqual(await store.listByTag('', 'alice'), []);
    assert.deepStrictEqual(await titles('sales', 'alice', { since: '2999-01-01T00:00:00Z' }), []);
    const [one] = await store.listByTag('sales', 'alice', { limit: 1 });
    assert.deepStrictEqual(Object.keys(one).sort(), [
        'actionItems', 'createdAt', 'decisions', 'id', 'organizationId', 'questions', 'summary', 'tags', 'title', 'updatedAt', 'userId',
    ]);
});

test('lookups by source uri, talk room and meet code; the series card', async () => {
    const a = await store.createTranscription({ userId: 'alice', organizationId: 'org1', title: 'S1', sourceUri: 'talk://r/1', talkRoomToken: 'room', meetMeetingCode: 'abc-defg-hij' });
    const dup = await store.createTranscription({ userId: 'bob', title: 'S1 again', sourceUri: 'talk://r/1' });
    assert.deepStrictEqual(dup, { id: a.id, userId: 'alice', organizationId: 'org1', dedup: true });
    assert.strictEqual((await store.getTranscriptionBySourceUri('talk://r/1')).id, a.id);
    assert.strictEqual(await store.getTranscriptionBySourceUri(''), null);
    assert.strictEqual((await store.getTranscriptionByTalkRoomToken('room', 'alice')).id, a.id);
    assert.strictEqual(await store.getTranscriptionByTalkRoomToken('room', 'bob'), null);
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij')).id, a.id);

    const later = await store.createTranscription({ userId: 'alice', title: 'S2', meetMeetingCode: 'abc-defg-hij' });
    const prev = await store.getSeriesPrevious({
        meetMeetingCode: 'abc-defg-hij', beforeCreatedAt: '2999-01-01T00:00:00Z', excludeId: later.id, userId: 'alice',
    });
    assert.strictEqual(prev.id, a.id);
    assert.deepStrictEqual(prev.openActionItems, []);
    assert.strictEqual(await store.getSeriesPrevious({
        meetMeetingCode: 'abc-defg-hij', beforeCreatedAt: '2999-01-01T00:00:00Z', excludeId: later.id, userId: 'zed',
    }), null);
    assert.strictEqual(await store.getSeriesPrevious({ userId: 'alice' }), null);
});

test('claim, finish, reaper: one owner per run, a lost claim writes nothing', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Run', status: 'completed' });
    assert.strictEqual(await store.claimForProcessing(id, 'bob'), false, 'not the owner');
    assert.strictEqual(await store.claimForProcessing(id, 'alice'), true);
    assert.strictEqual(await store.claimForProcessing(id, 'alice'), false, 'already processing');
    assert.strictEqual(await store.finishProcessing(id, 'alice', { status: 'completed', summary: 'Done.' }), true);
    assert.strictEqual(await store.finishProcessing(id, 'alice', { status: 'failed' }), false, 'claim lost');
    const done = await store.getTranscription(id, 'alice');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(done.summary, 'Done.');

    assert.strictEqual(await store.claimForProcessing(id, 'alice'), true);
    await pg.exec(`UPDATE transcriptions SET updated_at = NOW() - INTERVAL '4 hours' WHERE id = '${id}'`);
    assert.strictEqual(await store.timeoutStuckTranscriptions({ stuckMinutes: 180 }), 1);
    assert.strictEqual((await store.getTranscription(id, 'alice')).status, 'failed');
});

test('updates are owner-only and report what landed', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Draft' });
    assert.strictEqual(await store.updateTranscription(id, 'bob', { title: 'Hijack' }), false);
    assert.strictEqual(await store.updateTranscription(id, 'alice', {}), false, 'nothing to write');
    assert.strictEqual(await store.updateTranscription(id, 'alice', { title: 'Renamed' }), true);
    assert.strictEqual(await store.updateTranscription(id, 'alice', { titleIfUnchanged: { title: 'AI', expected: 'Draft' } }), true);
    assert.strictEqual((await store.getTranscription(id, 'alice')).title, 'Renamed', 'a user rename wins');
    const landed = await store.updateTranscription(id, 'alice', { actionItems: [{ id: 'x', text: 'Do' }] });
    assert.strictEqual(landed.ok, true);
    assert.deepStrictEqual(landed.actionItems.map(r => r.id), ['x']);
    assert.deepStrictEqual(landed.decisions, []);
});

test('publish stamps a missing org and never moves one; delete is owner-only', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'NoOrg' });
    assert.strictEqual(await store.setPublished(id, 'bob', true, [], 'orgB'), false);
    assert.strictEqual(await store.setPublished(id, 'alice', true, [], 'org1'), true);
    assert.strictEqual(await store.setPublished(id, 'alice', true, [], 'org9'), true);
    const n = await store.getTranscription(id, 'alice');
    assert.strictEqual(n.organizationId, 'org1');
    assert.strictEqual(n.isPublished, true);

    assert.strictEqual(await store.deleteTranscription(id, 'bob'), false);
    assert.strictEqual(await store.deleteTranscription(id, 'alice'), true);
    assert.strictEqual(await store.getTranscription(id, 'alice'), null);
});
