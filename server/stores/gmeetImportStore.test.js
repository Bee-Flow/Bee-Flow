// @typecheck
/**
 * gmeetImportStore — the Google Meet import queue, against a real Postgres
 * (PGlite behind db.js's pool, recorded by testUtils/routeHarness.js recordDb)
 * with the store's own schema and NOW() pinned (testUtils/pgliteClock.js): the
 * seed dedupe on the partial uniques, the leased claim, the failure backoff and
 * the sibling wake-ups, read back from the table.
 *
 * Run: node --test server/stores/gmeetImportStore.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { newPglite } = require('../testUtils/pgliteTemplate');
const { pinPgliteNow } = require('../testUtils/pgliteClock');
const { insertRow } = require('../testUtils/pgliteSeed');
const { failReads } = require('../testUtils/pgliteFaults');
const { recordDb } = require('../testUtils/routeHarness');

const pg = newPglite();
const rec = recordDb(undefined, { pg });
const store = require('./gmeetImportStore');

const NOW = new Date('2026-07-17T10:00:00.000Z');
const MIN = 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/** @type {{ set: (at: Date | string) => Promise<void> }} */
let clock;
before(async () => {
    await store.initDB();
    clock = await pinPgliteNow(pg, NOW);
});
after(() => pg.close());
beforeEach(async () => {
    await pg.exec('TRUNCATE gmeet_import_jobs');
    await clock.set(NOW);
    rec.reset();
});

const stored = async (id) => (await pg.query('SELECT * FROM gmeet_import_jobs WHERE id = $1', [id])).rows[0];
/** A job row as another writer left it. */
const job = (over = {}) => insertRow(pg, 'gmeet_import_jobs', { user_id: 'u1', org_id: 'org1', meeting_code: 'abc-defg-hij', ...over });

// ── seedJob ─────────────────────────────────────────────────────────────

test('seedJob inserts the job and returns the mapped row', async () => {
    const row = await store.seedJob({
        userId: 'u1', orgId: 'org1', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij',
        title: 'Standup', meetingStart: '2026-07-17T09:00:00Z', meetingEnd: '2026-07-17T09:30:00Z', preferred: true,
    });
    assert.strictEqual(row.userId, 'u1');
    assert.strictEqual(row.orgId, 'org1');
    assert.strictEqual(row.calendarEventId, 'ev1');
    assert.strictEqual(row.meetingCode, 'abc-defg-hij');
    assert.strictEqual(row.preferred, true);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.meetingStart, '2026-07-17T09:00:00.000Z');
    assert.strictEqual(row.nextAttemptAt, NOW.toISOString(), 'due at once unless told otherwise');
    const later = await store.seedJob({ userId: 'u1', calendarEventId: 'ev2', meetingCode: 'x', nextAttemptAt: at(5 * MIN).toISOString() });
    assert.strictEqual(later.nextAttemptAt, at(5 * MIN).toISOString());
});

test('seedJob returns null when the event was already seeded for that user (conflict → no row)', async () => {
    const first = await store.seedJob({ userId: 'u1', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij', title: 'first' });
    assert.strictEqual(await store.seedJob({ userId: 'u1', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij', title: 'again' }), null);
    assert.strictEqual((await stored(first.id)).title, 'first', 'the first seed stands');
    assert.ok(await store.seedJob({ userId: 'u2', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij' }), 'another attendee seeds their own');
    assert.ok(await store.seedJob({ userId: 'u1', meetingCode: 'abc-defg-hij' }), 'no calendar event: the unique does not apply');
    assert.ok(await store.seedJob({ userId: 'u1', meetingCode: 'abc-defg-hij' }));
});

test('seedJob answers a clash on the conference-record uniques with null', async () => {
    assert.ok(await store.seedJob({ userId: 'u1', orgId: 'org1', meetingCode: 'm', conferenceRecord: 'conferenceRecords/x' }));
    assert.strictEqual(await store.seedJob({ userId: 'u1', meetingCode: 'm', conferenceRecord: 'conferenceRecords/x' }), null, 'same user');
    assert.strictEqual(await store.seedJob({ userId: 'u2', orgId: 'org1', meetingCode: 'm', conferenceRecord: 'conferenceRecords/x' }), null, 'same organisation');
    assert.ok(await store.seedJob({ userId: 'u2', orgId: 'org2', meetingCode: 'm', conferenceRecord: 'conferenceRecords/x' }), 'another organisation has its own claim');
});

// ── claimDueJobs ────────────────────────────────────────────────────────

test('claimDueJobs takes the due rows preferred-first, under a lock, and bumps their lease', async () => {
    const a = await job({ preferred: false, next_attempt_at: at(-30 * MIN) });
    const b = await job({ preferred: true, next_attempt_at: at(-5 * MIN), status: 'awaiting_artifacts' });
    const c = await job({ preferred: false, next_attempt_at: at(-10 * MIN) });
    await job({ next_attempt_at: at(MIN) });                         // not yet due
    await job({ next_attempt_at: at(-60 * MIN), status: 'ingested' }); // done
    await job({ next_attempt_at: at(-60 * MIN), status: 'duplicate' }); // parked

    const jobs = await store.claimDueJobs(2);
    // Which rows the limit admits is the order's job: the preferred one, then
    // the longest-waiting. (The batch itself comes back in RETURNING order; the
    // worker claims one job at a time.)
    assert.deepStrictEqual(jobs.map((j) => j.id).sort(), [a.id, b.id].sort(), 'preferred first, then the longest-waiting');
    assert.strictEqual(jobs.find((j) => j.id === b.id).status, 'awaiting_artifacts');
    for (const j of jobs) assert.strictEqual(iso((await stored(j.id)).next_attempt_at), at(10 * MIN).toISOString(), 'leased for ten minutes');
    assert.strictEqual(iso((await stored(c.id)).next_attempt_at), at(-10 * MIN).toISOString(), 'beyond the limit: untouched');

    const verbs = rec.all.map((s) => s.trim().split(/\s+/)[0]);
    assert.deepStrictEqual(verbs, ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
    assert.match(rec.all[1], /FOR UPDATE SKIP LOCKED/, 'concurrent workers skip each other\'s rows');

    // A second worker right after finds only the third due row.
    assert.deepStrictEqual((await store.claimDueJobs(5)).map((j) => j.id), [c.id]);
    assert.deepStrictEqual(await store.claimDueJobs(5), [], 'everything is leased now');
});

test('claimDueJobs commits and returns [] when nothing is due (no lease UPDATE)', async () => {
    await job({ next_attempt_at: at(MIN) });
    assert.deepStrictEqual(await store.claimDueJobs(5), []);
    assert.deepStrictEqual(rec.all.map((s) => s.trim().split(/\s+/)[0]), ['BEGIN', 'SELECT', 'COMMIT']);
});

test('claimDueJobs rolls back and rethrows when the read fails', async () => {
    await job({ next_attempt_at: at(-MIN) });
    const restore = await failReads(pg, 'gmeet_import_jobs', '57014', 'canceling statement due to statement timeout');
    try {
        await assert.rejects(() => store.claimDueJobs(2), { code: '57014' });
    } finally {
        await restore();
    }
    assert.strictEqual(rec.all.at(-1).trim(), 'ROLLBACK');
    assert.strictEqual((await store.claimDueJobs(2)).length, 1, 'the session is usable again and the row still due');
});

// ── failJob ─────────────────────────────────────────────────────────────

test('failJob terminal bumps attempts and freezes status on the error code, without rescheduling', async () => {
    const j = await job({ attempts: 2, next_attempt_at: at(-MIN) });
    await store.failJob(j.id, { errorCode: 'no_drive_access', lastError: '403 from Drive', terminal: true });
    const row = await stored(j.id);
    assert.strictEqual(row.attempts, 3);
    assert.strictEqual(row.status, 'no_drive_access');
    assert.strictEqual(row.error_code, 'no_drive_access');
    assert.strictEqual(row.last_error, '403 from Drive');
    assert.strictEqual(iso(row.next_attempt_at), at(-MIN).toISOString(), 'a terminal failure does not reschedule');
});

test('failJob terminal without errorCode falls back to status failed', async () => {
    const j = await job();
    await store.failJob(j.id, { lastError: 'whisperx exploded', terminal: true });
    const row = await stored(j.id);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error_code, null);
    assert.strictEqual(row.last_error, 'whisperx exploded');
});

test('failJob non-terminal reschedules by backoffMs and restores the passed status', async () => {
    const j = await job({ status: 'pending' });
    await store.failJob(j.id, { errorCode: 'artifacts_pending', lastError: 'not ready', backoffMs: 300000, status: 'awaiting_artifacts' });
    const row = await stored(j.id);
    assert.strictEqual(row.attempts, 1);
    assert.strictEqual(row.status, 'awaiting_artifacts');
    assert.strictEqual(row.error_code, 'artifacts_pending');
    assert.strictEqual(iso(row.next_attempt_at), at(5 * MIN).toISOString());
});

test('failJob non-terminal without status keeps the current status', async () => {
    const j = await job({ status: 'awaiting_artifacts' });
    await store.failJob(j.id, { errorCode: 'transient', backoffMs: 120000 });
    const row = await stored(j.id);
    assert.strictEqual(row.status, 'awaiting_artifacts');
    assert.strictEqual(iso(row.next_attempt_at), at(2 * MIN).toISOString());
});

// ── attachConferenceRecord ──────────────────────────────────────────────

test('attachConferenceRecord updates space + record and returns the mapped row', async () => {
    const j = await job({ space_name: 'spaces/old' });
    const row = /** @type {any} */ (await store.attachConferenceRecord(j.id, { conferenceRecord: 'conferenceRecords/y' }));
    assert.strictEqual(row.spaceName, 'spaces/old', 'no space given keeps the stored one');
    assert.strictEqual(row.conferenceRecord, 'conferenceRecords/y');
    const again = /** @type {any} */ (await store.attachConferenceRecord(j.id, { spaceName: 'spaces/x', conferenceRecord: 'conferenceRecords/y' }));
    assert.strictEqual(again.spaceName, 'spaces/x');
    assert.strictEqual((await stored(j.id)).space_name, 'spaces/x');
});

test('attachConferenceRecord returns { duplicate: true } when the organisation already claimed the record', async () => {
    await job({ user_id: 'u2', conference_record: 'conferenceRecords/y' });
    const mine = await job();
    assert.deepStrictEqual(await store.attachConferenceRecord(mine.id, { conferenceRecord: 'conferenceRecords/y' }), { duplicate: true });
    assert.strictEqual((await stored(mine.id)).conference_record, null);
});

test('attachConferenceRecord rethrows anything that is not a unique violation', async () => {
    const restore = await failReads(pg, 'gmeet_import_jobs', '08006', 'connection failure');
    try {
        await assert.rejects(
            () => store.attachConferenceRecord('11111111-1111-1111-1111-111111111111', { conferenceRecord: 'conferenceRecords/y' }),
            (e) => /** @type {any} */ (e).code !== '23505',
        );
    } finally {
        await restore();
    }
});

// ── completeJob / parkNeedsReauth / updateJob / listRecentJobsForUser ───

test('completeJob marks ingested, links the transcription, clears the error, and wakes the parked org siblings', async () => {
    const mine = await job({ error_code: 'artifacts_pending', last_error: 'x', conference_record: 'conferenceRecords/c', space_name: 'spaces/s' });
    const sibling = await job({ user_id: 'u2', status: 'duplicate', next_attempt_at: at(60 * MIN) });
    const sameSpace = await job({ user_id: 'u3', status: 'duplicate', meeting_code: 'other', space_name: 'spaces/s' });
    const otherOrg = await job({ user_id: 'u4', org_id: 'org2', status: 'duplicate' });
    const otherMeeting = await job({ user_id: 'u5', status: 'duplicate', meeting_code: 'zzz' });
    const hasNote = await job({ user_id: 'u6', status: 'duplicate', transcription_id: 't-old' });

    assert.strictEqual(await store.completeJob(mine.id, 't-123'), true);
    const row = await stored(mine.id);
    assert.strictEqual(row.status, 'ingested');
    assert.strictEqual(row.transcription_id, 't-123');
    assert.strictEqual(row.error_code, null);
    assert.strictEqual(row.last_error, null);

    // The siblings go back to the queue, so resolveDuplicate decides per
    // sibling whether it may read the note; the note id is never copied.
    const s = await stored(sibling.id);
    assert.strictEqual(s.status, 'pending');
    assert.strictEqual(iso(s.next_attempt_at), NOW.toISOString(), 'claimable immediately');
    assert.strictEqual(s.transcription_id, null);
    assert.strictEqual((await stored(sameSpace.id)).status, 'pending', 'the same meeting by its space');
    for (const other of [otherOrg, otherMeeting, hasNote]) assert.strictEqual((await stored(other.id)).status, 'duplicate');
});

test('completeJob on a job that is gone wakes nobody', async () => {
    const parked = await job({ status: 'duplicate' });
    assert.strictEqual(await store.completeJob('11111111-1111-1111-1111-111111111111', 't-1'), false);
    assert.strictEqual((await stored(parked.id)).status, 'duplicate');
});

test('a manual request is kept on the job: requested_by_user, language, context terms', async () => {
    const j = await job();
    assert.strictEqual(await store.updateJob(j.id, { requestedByUser: true, requestedLanguage: 'en', contextTerms: 'Foo' }), true);
    const plain = await job({ user_id: 'u1', meeting_code: 'other' });
    await pg.query('UPDATE gmeet_import_jobs SET created_at = $2 WHERE id = $1', [plain.id, at(-MIN)]);
    const [manual, auto] = await store.listRecentJobsForUser('u1', 3);
    assert.strictEqual(manual.requestedByUser, true);
    assert.strictEqual(manual.requestedLanguage, 'en');
    assert.strictEqual(manual.contextTerms, 'Foo');
    assert.strictEqual(auto.requestedByUser, false);
    assert.strictEqual(auto.requestedLanguage, null);
    assert.strictEqual(auto.contextTerms, null);
});

test('parkNeedsReauth parks the job with the given resume time', async () => {
    const j = await job();
    assert.strictEqual(await store.parkNeedsReauth(j.id, '2026-07-18T00:00:00Z'), true);
    const row = await stored(j.id);
    assert.strictEqual(row.status, 'needs_reauth');
    assert.strictEqual(row.error_code, 'needs_reauth');
    assert.strictEqual(iso(row.next_attempt_at), '2026-07-18T00:00:00.000Z');
});

test('updateJob writes only the passed fields', async () => {
    const j = await job({ error_code: 'keep-me', title: 'keep' });
    await clock.set(at(MIN));
    assert.strictEqual(await store.updateJob(j.id, { status: 'awaiting_artifacts', attempts: 3, transcriptionId: 't-1' }), true);
    const row = await stored(j.id);
    assert.strictEqual(row.status, 'awaiting_artifacts');
    assert.strictEqual(row.attempts, 3);
    assert.strictEqual(row.transcription_id, 't-1');
    assert.strictEqual(row.error_code, 'keep-me', 'untouched columns keep their value');
    assert.strictEqual(row.title, 'keep');
    assert.strictEqual(iso(row.updated_at), at(MIN).toISOString());
    assert.strictEqual(await store.updateJob('11111111-1111-1111-1111-111111111111', { status: 'x' }), false, 'no such job');
});

test('updateJob with no known fields is a no-op returning false', async () => {
    const j = await job();
    rec.reset();
    assert.strictEqual(await store.updateJob(j.id, { bogus: 1 }), false);
    assert.deepStrictEqual(rec.queries, [], 'no query issued');
});

test('listRecentJobsForUser returns the user\'s jobs inside the window, newest first', async () => {
    const recent = await job({ status: 'ingested', transcription_id: 't-9' });
    const older = await job({ meeting_code: 'b' });
    const old = await job({ meeting_code: 'c' });
    await job({ user_id: 'u2', meeting_code: 'd' });
    await pg.query('UPDATE gmeet_import_jobs SET created_at = $2 WHERE id = $1', [older.id, at(-2 * 24 * 60 * MIN)]);
    await pg.query('UPDATE gmeet_import_jobs SET created_at = $2 WHERE id = $1', [old.id, at(-4 * 24 * 60 * MIN)]);
    const jobs = await store.listRecentJobsForUser('u1', 3);
    assert.deepStrictEqual(jobs.map((j) => j.id), [recent.id, older.id]);
    assert.strictEqual(jobs[0].transcriptionId, 't-9');
    assert.strictEqual(jobs[0].status, 'ingested');
});

// ── releaseConferenceClaim ───────────────────────────────────────────
//
// A terminally-failed claim owner must not hold the (org_id, conference_record)
// slot forever, or every other attendee's job stays parked at `duplicate` with
// no note and no error.

test('releaseConferenceClaim frees the slot and returns the parked siblings of the same meeting to pending', async () => {
    const owner = await job({ conference_record: 'conferenceRecords/cr1', status: 'failed' });
    const s1 = await job({ user_id: 'u2', status: 'duplicate', error_code: 'duplicate', next_attempt_at: at(60 * MIN) });
    const s2 = await job({ user_id: 'u3', status: 'duplicate' });
    const otherOrg = await job({ user_id: 'u4', org_id: 'org2', status: 'duplicate' });
    const madeNote = await job({ user_id: 'u5', status: 'duplicate', transcription_id: 't-1' });

    assert.strictEqual(await store.releaseConferenceClaim(owner.id), 2);
    assert.strictEqual((await stored(owner.id)).conference_record, null, 'the index slot is freed');
    assert.strictEqual((await stored(owner.id)).status, 'failed', 'the owner itself is not woken');
    for (const s of [s1, s2]) {
        const row = await stored(s.id);
        assert.strictEqual(row.status, 'pending');
        assert.strictEqual(row.error_code, null);
        assert.strictEqual(iso(row.next_attempt_at), NOW.toISOString(), 'woken siblings are claimable immediately');
    }
    assert.strictEqual((await stored(otherOrg.id)).status, 'duplicate');
    assert.strictEqual((await stored(madeNote.id)).status, 'duplicate', 'never re-run a job that already made a note');
    // The freed slot can be claimed by a sibling now.
    assert.ok(!('duplicate' in (await store.attachConferenceRecord(s1.id, { conferenceRecord: 'conferenceRecords/cr1' }))));
});

test('releaseConferenceClaim is a no-op when the job holds no claim', async () => {
    const owner = await job();
    const parked = await job({ user_id: 'u2', status: 'duplicate' });
    rec.reset();
    assert.strictEqual(await store.releaseConferenceClaim(owner.id), 0);
    assert.strictEqual(rec.queries.filter((q) => /^\s*UPDATE/i.test(q)).length, 0, 'nothing is written');
    assert.strictEqual((await stored(parked.id)).status, 'duplicate');
});

test('releaseConferenceClaim on a personal job frees the slot but wakes nobody', async () => {
    const owner = await job({ org_id: null, conference_record: 'conferenceRecords/cr1' });
    const parked = await job({ org_id: null, user_id: 'u2', status: 'duplicate' });
    assert.strictEqual(await store.releaseConferenceClaim(owner.id), 0);
    assert.strictEqual((await stored(owner.id)).conference_record, null);
    assert.strictEqual((await stored(parked.id)).status, 'duplicate');
});
