'use strict';

/**
 * stores/transcription/lifecycle.js against a real Postgres (PGlite behind
 * db.js): the reaper's threshold, reason and heartbeat; "Personal" revoking
 * the attendee grants of an import; and a delete that never drops the only
 * reference to a durable recording it could not remove.
 *
 * Run: cd server && node --test stores/transcription/lifecycle.pg.test.js
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { makeSwaps } = require('../../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('../transcriptionStore');
const lifecycle = require('./lifecycle');
const transcriptCrypto = require('../transcriptCrypto');
const storageStore = require('../storageStore');

const fileSwaps = makeSwaps();
const testSwaps = makeSwaps();

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO projects VALUES ('p1','alice','org1');
    `);
    fileSwaps.swap(transcriptCrypto, 'resolveTranscriptCrypto', async () => transcriptCrypto.PLAINTEXT_CONTEXT);
    await store.initDB();
});

afterEach(() => testSwaps.restore());

after(async () => {
    fileSwaps.restore();
    await close();
});

/** @param {string} id @param {number} minutes */
const ageBy = (id, minutes) => pg.exec(`UPDATE transcriptions SET updated_at = NOW() - INTERVAL '${minutes} minutes' WHERE id = '${id}'`);
/** @param {string} id */
const rawRow = async (id) => (await pg.query('SELECT status, summary, shared_with, is_published FROM transcriptions WHERE id = $1', [id])).rows[0];

test('reaper: a run inside the engine caps (Azure 4 h + LLM passes) is not reaped by default', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Long Azure meeting', status: 'processing' });
    await ageBy(id, 4 * 60 + 30);
    await lifecycle.timeoutStuckTranscriptions();
    assert.strictEqual((await rawRow(id)).status, 'processing', 'a healthy 4.5 h run keeps running');
    assert.ok(lifecycle.DEFAULT_STUCK_MINUTES > 4 * 60, 'the default sits above the largest engine cap');
    await pg.exec(`DELETE FROM transcriptions WHERE id = '${id}'`);
});

test('reaper: a silent run past the threshold fails WITH a reason, and an old summary is kept', async () => {
    const empty = await store.createTranscription({ userId: 'alice', title: 'Upload', status: 'processing' });
    const reproc = await store.createTranscription({ userId: 'alice', title: 'Reprocess', status: 'completed', summary: 'We agreed on X.' });
    assert.strictEqual(await store.claimForProcessing(reproc.id, 'alice'), true);
    await ageBy(empty.id, lifecycle.DEFAULT_STUCK_MINUTES + 1);
    await ageBy(reproc.id, lifecycle.DEFAULT_STUCK_MINUTES + 1);

    assert.strictEqual(await lifecycle.timeoutStuckTranscriptions(), 2);
    const a = await rawRow(empty.id);
    assert.strictEqual(a.status, 'failed');
    assert.strictEqual(a.summary, lifecycle.REAPED_REASON);
    assert.match(a.summary, /^Transcription failed: /);
    const listed = (await store.getTranscriptions('alice')).find((n) => n.id === empty.id);
    assert.strictEqual(listed.failureReason, lifecycle.REAPED_REASON, 'the list shows why it failed');

    const b = await rawRow(reproc.id);
    assert.strictEqual(b.status, 'failed');
    assert.strictEqual(b.summary, 'We agreed on X.', 'the reaper never overwrites a real summary');
});

test('heartbeat: a run that keeps reporting is never reaped, a reaped run learns it lost the claim', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Beating', status: 'processing' });
    await ageBy(id, 10_000);
    assert.strictEqual(await lifecycle.heartbeatProcessing(id), true);
    await lifecycle.timeoutStuckTranscriptions({ stuckMinutes: 180 });
    assert.strictEqual((await rawRow(id)).status, 'processing');

    await ageBy(id, 181);
    assert.strictEqual(await lifecycle.timeoutStuckTranscriptions({ stuckMinutes: 180 }), 1);
    assert.strictEqual(await lifecycle.heartbeatProcessing(id), false, 'no longer processing');
    assert.strictEqual(await lifecycle.heartbeatProcessing(''), false);
});

test('reaper threshold: MEETING_NOTES_STUCK_MINUTES overrides it, 0 switches the reaper off', async () => {
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({}), lifecycle.DEFAULT_STUCK_MINUTES);
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({ MEETING_NOTES_STUCK_MINUTES: '' }), lifecycle.DEFAULT_STUCK_MINUTES);
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({ MEETING_NOTES_STUCK_MINUTES: '720' }), 720);
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({ MEETING_NOTES_STUCK_MINUTES: '0' }), 0);
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({ MEETING_NOTES_STUCK_MINUTES: 'soon' }), lifecycle.DEFAULT_STUCK_MINUTES);
    assert.strictEqual(lifecycle.stuckMinutesFromEnv({ MEETING_NOTES_STUCK_MINUTES: '-5' }), lifecycle.DEFAULT_STUCK_MINUTES);

    const { id } = await store.createTranscription({ userId: 'alice', title: 'Off', status: 'processing' });
    await ageBy(id, 100_000);
    assert.strictEqual(await lifecycle.timeoutStuckTranscriptions({ stuckMinutes: 0 }), 0);
    assert.strictEqual((await rawRow(id)).status, 'processing');
    await pg.exec(`DELETE FROM transcriptions WHERE id = '${id}'`);
});

test('Personal revokes the attendee grants of an import, and the note can then be filed into a project', async () => {
    const { id } = await store.createTranscription({
        userId: 'alice', organizationId: 'org1', title: 'Teams import', source: 'teams', sharedWith: ['bob', 'carol'],
    });
    assert.ok(await store.getTranscription(id, 'bob', { orgIds: ['org1'] }), 'the attendee reads it after the import');

    // Publishing only widens: the attendees keep their grant.
    assert.strictEqual(await store.setPublished(id, 'alice', true, [], 'org1'), true);
    assert.deepStrictEqual((await rawRow(id)).shared_with, ['bob', 'carol']);

    assert.strictEqual(await store.setPublished(id, 'alice', false, [], 'org1'), true);
    const row = await rawRow(id);
    assert.deepStrictEqual(row.shared_with, []);
    assert.strictEqual(row.is_published, false);
    assert.strictEqual(await store.getTranscription(id, 'bob', { orgIds: ['org1'] }), null, 'Personal means only the owner');

    assert.strictEqual(await store.setTranscriptionProject(id, 'alice', 'p1', ['org1']), true, 'no 409 MEETING_ALREADY_SHARED');
});

test('delete with a durable recording: storage unreachable refuses (503) and keeps the note', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Rec', audioStorageKey: 'saved-recordings/abc.webm' });
    const deleted = [];
    testSwaps.swap(storageStore, 'ensureAvailable', async () => false);
    testSwaps.swap(storageStore, 'deleteFile', async (key) => { deleted.push(key); });

    await assert.rejects(() => store.deleteTranscription(id, 'alice'), (e) => e.status === 503 && e.code === 'recording_storage_unavailable');
    assert.deepStrictEqual(deleted, []);
    assert.ok(await rawRow(id), 'the row, the only reference to the key, is still there');
});

test('delete with a durable recording: a failing object delete refuses (503) and keeps the note', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Rec 2', audioStorageKey: 'saved-recordings/def.webm' });
    testSwaps.swap(storageStore, 'ensureAvailable', async () => true);
    testSwaps.swap(storageStore, 'deleteFile', async () => { throw new Error('connect ECONNREFUSED'); });

    await assert.rejects(() => store.deleteTranscription(id, 'alice'), (e) => e.status === 503);
    assert.ok(await rawRow(id));
});

test('delete with a durable recording: object and row both go; owner-only', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'Rec 3', audioStorageKey: 'saved-recordings/ghi.webm' });
    const deleted = [];
    testSwaps.swap(storageStore, 'ensureAvailable', async () => true);
    testSwaps.swap(storageStore, 'deleteFile', async (key) => { deleted.push(key); });

    assert.strictEqual(await store.deleteTranscription(id, 'bob'), false);
    assert.deepStrictEqual(deleted, [], 'a stranger deletes nothing, not even the object');
    assert.strictEqual(await store.deleteTranscription(id, 'alice'), true);
    assert.deepStrictEqual(deleted, ['saved-recordings/ghi.webm']);
    assert.strictEqual(await rawRow(id), undefined);
});

test('delete without a durable recording never needs storage', async () => {
    const { id } = await store.createTranscription({ userId: 'alice', title: 'No audio' });
    testSwaps.swap(storageStore, 'ensureAvailable', async () => { throw new Error('must not be asked'); });
    assert.strictEqual(await store.deleteTranscription(id, 'alice'), true);
    assert.strictEqual(await rawRow(id), undefined);
});
