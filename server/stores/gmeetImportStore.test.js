/**
 * Unit tests for gmeetImportStore — SQL shape + error handling. A fake `db`
 * module is injected into require.cache so the store's `require('../db')`
 * captures every query's text + params instead of hitting Postgres.
 * No real database needed.
 *
 * Run: node --test server/stores/gmeetImportStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── Fake of server/db.js: captures SQL + params, replays scripted results ──
const state = {
    calls: [],           // { fn, sql, params }
    runResult: { rowCount: 1, rows: [] },
    runError: null,      // one-shot: thrown by the next run() then cleared
    allRows: [],
    claimIds: [],        // ids returned by the claim SELECT
    claimRows: [],       // rows returned by the claim UPDATE
    selectError: null,   // one-shot: thrown by the claim SELECT
    lastClient: null,
};

function resetState() {
    state.calls = [];
    state.runResult = { rowCount: 1, rows: [] };
    state.runError = null;
    state.allRows = [];
    state.claimIds = [];
    state.claimRows = [];
    state.selectError = null;
    state.lastClient = null;
}

function makeClient() {
    const client = {
        calls: [],
        released: false,
        query: async (sql, params) => {
            client.calls.push({ sql, params });
            if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
            if (/SELECT id FROM gmeet_import_jobs/.test(sql)) {
                if (state.selectError) { const e = state.selectError; state.selectError = null; throw e; }
                return { rows: state.claimIds.map(id => ({ id })), rowCount: state.claimIds.length };
            }
            if (/UPDATE gmeet_import_jobs/.test(sql)) {
                return { rows: state.claimRows, rowCount: state.claimRows.length };
            }
            return { rows: [], rowCount: 0 };
        },
        release: () => { client.released = true; },
    };
    state.lastClient = client;
    return client;
}

const mockDb = {
    exec: async (sql) => { state.calls.push({ fn: 'exec', sql, params: [] }); },
    run: async (sql, params = []) => {
        state.calls.push({ fn: 'run', sql, params });
        if (state.runError) { const e = state.runError; state.runError = null; throw e; }
        return state.runResult;
    },
    getOne: async (sql, params = []) => {
        state.calls.push({ fn: 'getOne', sql, params });
        return state.allRows[0] || null;
    },
    getAll: async (sql, params = []) => {
        state.calls.push({ fn: 'getAll', sql, params });
        return state.allRows;
    },
    getClient: async () => makeClient(),
};

const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./gmeetImportStore');

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const lastRun = () => state.calls.filter(c => c.fn === 'run').at(-1);

function jobRow(overrides = {}) {
    return {
        id: '11111111-1111-1111-1111-111111111111',
        user_id: 'u1',
        org_id: 'org1',
        calendar_event_id: 'ev1',
        ical_uid: null,
        meeting_code: 'abc-defg-hij',
        space_name: null,
        conference_record: null,
        title: 'Standup',
        meeting_start: new Date('2026-07-17T09:00:00Z'),
        meeting_end: new Date('2026-07-17T09:30:00Z'),
        preferred: true,
        status: 'pending',
        error_code: null,
        last_error: null,
        attempts: 0,
        next_attempt_at: new Date('2026-07-17T09:30:00Z'),
        transcription_id: null,
        created_at: new Date('2026-07-17T08:00:00Z'),
        updated_at: new Date('2026-07-17T08:00:00Z'),
        ...overrides,
    };
}

beforeEach(() => resetState());

// ── seedJob ─────────────────────────────────────────────────────────────

test('seedJob inserts with the (user_id, calendar_event_id) ON CONFLICT clause and returns the mapped row', async () => {
    state.runResult = { rowCount: 1, rows: [jobRow()] };
    const row = await store.seedJob({
        userId: 'u1', orgId: 'org1', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij',
        title: 'Standup', meetingStart: '2026-07-17T09:00:00Z', meetingEnd: '2026-07-17T09:30:00Z', preferred: true,
    });
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /INSERT INTO gmeet_import_jobs/);
    assert.match(sql, /ON CONFLICT \(user_id, calendar_event_id\) WHERE calendar_event_id IS NOT NULL DO NOTHING/);
    assert.match(sql, /RETURNING \*/);
    assert.strictEqual(call.params[0], 'u1');
    assert.strictEqual(call.params[2], 'ev1');
    assert.strictEqual(call.params[4], 'abc-defg-hij');
    assert.strictEqual(call.params[10], true, 'preferred flag passed');
    assert.strictEqual(row.userId, 'u1');
    assert.strictEqual(row.meetingCode, 'abc-defg-hij');
    assert.strictEqual(row.preferred, true);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.meetingStart, '2026-07-17T09:00:00.000Z');
});

test('seedJob returns null when the event was already seeded (conflict → no row)', async () => {
    state.runResult = { rowCount: 0, rows: [] };
    const row = await store.seedJob({ userId: 'u1', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij' });
    assert.strictEqual(row, null);
});

test('seedJob swallows a 23505 from the conference-record uniques as null', async () => {
    state.runError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const row = await store.seedJob({ userId: 'u1', meetingCode: 'abc-defg-hij', conferenceRecord: 'conferenceRecords/x' });
    assert.strictEqual(row, null);
});

// ── claimDueJobs ────────────────────────────────────────────────────────

test('claimDueJobs selects due rows with FOR UPDATE SKIP LOCKED, preferred-first ordering, and bumps the lease', async () => {
    state.claimIds = ['id-a', 'id-b'];
    state.claimRows = [jobRow({ id: 'id-a' }), jobRow({ id: 'id-b', preferred: false, status: 'awaiting_artifacts' })];

    const jobs = await store.claimDueJobs(2);
    const client = state.lastClient;
    const seq = client.calls.map(c => norm(c.sql));

    assert.strictEqual(seq[0], 'BEGIN');
    assert.strictEqual(seq.at(-1), 'COMMIT');
    assert.strictEqual(client.released, true, 'client released');

    const sel = client.calls.find(c => /SELECT id FROM gmeet_import_jobs/.test(c.sql));
    const selSql = norm(sel.sql);
    assert.match(selSql, /FOR UPDATE SKIP LOCKED/);
    assert.match(selSql, /ORDER BY preferred DESC, next_attempt_at ASC/);
    assert.match(selSql, /status IN \('pending', 'awaiting_artifacts'\)/);
    assert.match(selSql, /next_attempt_at <= NOW\(\)/);
    assert.deepStrictEqual(sel.params, [2]);

    const upd = client.calls.find(c => /UPDATE gmeet_import_jobs/.test(c.sql));
    const updSql = norm(upd.sql);
    assert.match(updSql, /next_attempt_at = NOW\(\) \+ INTERVAL '10 minutes'/, 'lease bump');
    assert.deepStrictEqual(upd.params, [['id-a', 'id-b']]);

    assert.strictEqual(jobs.length, 2);
    assert.strictEqual(jobs[0].id, 'id-a');
    assert.strictEqual(jobs[1].status, 'awaiting_artifacts');
});

test('claimDueJobs commits and returns [] when nothing is due (no lease UPDATE)', async () => {
    state.claimIds = [];
    const jobs = await store.claimDueJobs(5);
    const client = state.lastClient;
    assert.deepStrictEqual(jobs, []);
    assert.ok(!client.calls.some(c => /UPDATE gmeet_import_jobs/.test(c.sql)), 'no update issued');
    assert.strictEqual(norm(client.calls.at(-1).sql), 'COMMIT');
    assert.strictEqual(client.released, true);
});

test('claimDueJobs rolls back, releases, and rethrows on query failure', async () => {
    state.selectError = new Error('boom');
    await assert.rejects(() => store.claimDueJobs(2), /boom/);
    const client = state.lastClient;
    assert.ok(client.calls.some(c => /^ROLLBACK/.test(c.sql)), 'rollback issued');
    assert.strictEqual(client.released, true);
});

// ── failJob ─────────────────────────────────────────────────────────────

test('failJob terminal bumps attempts and freezes status on the error code', async () => {
    await store.failJob('id-a', { errorCode: 'no_drive_access', lastError: '403 from Drive', terminal: true });
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /attempts = attempts \+ 1/);
    assert.ok(!/next_attempt_at/.test(sql), 'terminal failure does not reschedule');
    assert.deepStrictEqual(call.params, ['id-a', 'no_drive_access', 'no_drive_access', '403 from Drive']);
});

test('failJob terminal without errorCode falls back to status failed', async () => {
    await store.failJob('id-a', { lastError: 'whisperx exploded', terminal: true });
    assert.deepStrictEqual(lastRun().params, ['id-a', 'failed', null, 'whisperx exploded']);
});

test('failJob non-terminal reschedules via backoffMs and restores the passed status', async () => {
    await store.failJob('id-a', { errorCode: 'artifacts_pending', lastError: 'not ready', backoffMs: 300000, status: 'awaiting_artifacts' });
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /attempts = attempts \+ 1/);
    assert.match(sql, /status = COALESCE\(\$2, status\)/);
    assert.match(sql, /next_attempt_at = NOW\(\) \+ \(\$5 \* INTERVAL '1 millisecond'\)/);
    assert.deepStrictEqual(call.params, ['id-a', 'awaiting_artifacts', 'artifacts_pending', 'not ready', 300000]);
});

test('failJob non-terminal without status keeps the current status (COALESCE with null)', async () => {
    await store.failJob('id-a', { errorCode: 'transient', backoffMs: 120000 });
    assert.deepStrictEqual(lastRun().params, ['id-a', null, 'transient', null, 120000]);
});

// ── attachConferenceRecord ──────────────────────────────────────────────

test('attachConferenceRecord updates space + record and returns the mapped row', async () => {
    state.runResult = { rowCount: 1, rows: [jobRow({ space_name: 'spaces/x', conference_record: 'conferenceRecords/y' })] };
    const row = await store.attachConferenceRecord('id-a', { spaceName: 'spaces/x', conferenceRecord: 'conferenceRecords/y' });
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /conference_record = \$3/);
    assert.deepStrictEqual(call.params, ['id-a', 'spaces/x', 'conferenceRecords/y']);
    assert.strictEqual(row.spaceName, 'spaces/x');
    assert.strictEqual(row.conferenceRecord, 'conferenceRecords/y');
});

test('attachConferenceRecord returns { duplicate: true } on the org-claim unique violation', async () => {
    state.runError = Object.assign(new Error('duplicate key value violates unique constraint "uq_gmeet_jobs_org_conference"'), { code: '23505' });
    const res = await store.attachConferenceRecord('id-a', { conferenceRecord: 'conferenceRecords/y' });
    assert.deepStrictEqual(res, { duplicate: true });
});

test('attachConferenceRecord rethrows non-unique-violation errors', async () => {
    state.runError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await assert.rejects(
        () => store.attachConferenceRecord('id-a', { conferenceRecord: 'conferenceRecords/y' }),
        /connection refused/,
    );
});

// ── completeJob / parkNeedsReauth / updateJob / listRecentJobsForUser ───

test('completeJob marks ingested, links the transcription, and clears error fields', async () => {
    await store.completeJob('id-a', 't-123');
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /status = 'ingested'/);
    assert.match(sql, /transcription_id = \$2/);
    assert.match(sql, /error_code = NULL/);
    assert.match(sql, /last_error = NULL/);
    assert.deepStrictEqual(call.params, ['id-a', 't-123']);
});

test('parkNeedsReauth parks the job with the given resume time', async () => {
    await store.parkNeedsReauth('id-a', '2026-07-18T00:00:00Z');
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /status = 'needs_reauth'/);
    assert.match(sql, /next_attempt_at = \$2/);
    assert.deepStrictEqual(call.params, ['id-a', '2026-07-18T00:00:00Z']);
});

test('updateJob builds a SET clause from only the passed fields', async () => {
    await store.updateJob('id-a', { status: 'awaiting_artifacts', attempts: 3, transcriptionId: 't-1' });
    const call = lastRun();
    const sql = norm(call.sql);
    assert.match(sql, /status = \$1/);
    assert.match(sql, /attempts = \$2/);
    assert.match(sql, /transcription_id = \$3/);
    assert.match(sql, /updated_at = NOW\(\)/);
    assert.ok(!/error_code/.test(sql), 'untouched columns stay out of the SET clause');
    assert.deepStrictEqual(call.params, ['awaiting_artifacts', 3, 't-1', 'id-a']);
});

test('updateJob with no known fields is a no-op returning false', async () => {
    const before = state.calls.filter(c => c.fn === 'run').length;
    const res = await store.updateJob('id-a', { bogus: 1 });
    assert.strictEqual(res, false);
    assert.strictEqual(state.calls.filter(c => c.fn === 'run').length, before, 'no query issued');
});

test('listRecentJobsForUser filters by user + window and maps rows', async () => {
    state.allRows = [jobRow({ status: 'ingested', transcription_id: 't-9' })];
    const jobs = await store.listRecentJobsForUser('u1', 3);
    const call = state.calls.filter(c => c.fn === 'getAll').at(-1);
    const sql = norm(call.sql);
    assert.match(sql, /WHERE user_id = \$1 AND created_at >= NOW\(\) - \(\$2 \* INTERVAL '1 day'\)/);
    assert.match(sql, /ORDER BY created_at DESC/);
    assert.deepStrictEqual(call.params, ['u1', 3]);
    assert.strictEqual(jobs[0].transcriptionId, 't-9');
    assert.strictEqual(jobs[0].status, 'ingested');
});

// ── releaseConferenceClaim ───────────────────────────────────────────
//
// A terminally-failed claim owner used to hold the (org_id, conference_record)
// slot forever, leaving every other attendee's job parked at `duplicate` with
// no note and no error — the meeting silently produced nothing for anyone.

test('releaseConferenceClaim frees the slot and returns the org siblings to pending', async () => {
    resetState();
    state.allRows = [{ org_id: 'org1', conference_record: 'conferenceRecords/cr1' }];
    state.runResult = { rowCount: 2, rows: [] };

    const woken = await store.releaseConferenceClaim('id-a');
    assert.strictEqual(woken, 2);

    const runs = state.calls.filter(c => c.fn === 'run');
    const clear = norm(runs[0].sql);
    assert.match(clear, /SET conference_record = NULL/, 'the index slot is freed');
    assert.deepStrictEqual(runs[0].params, ['id-a']);

    const wake = norm(runs[1].sql);
    assert.match(wake, /SET status = 'pending'/);
    assert.match(wake, /error_code = NULL/);
    assert.match(wake, /next_attempt_at = NOW\(\)/, 'woken siblings are claimable immediately');
    assert.match(wake, /status = 'duplicate'/, 'only parked siblings');
    assert.match(wake, /transcription_id IS NULL/, 'never re-run a job that already made a note');
    assert.match(wake, /id <> \$2/, 'never wakes itself');
    assert.deepStrictEqual(runs[1].params, ['org1', 'id-a']);
});

test('releaseConferenceClaim is a no-op when the job holds no claim', async () => {
    resetState();
    state.allRows = [{ org_id: 'org1', conference_record: null }];
    const woken = await store.releaseConferenceClaim('id-a');
    assert.strictEqual(woken, 0);
    assert.strictEqual(state.calls.filter(c => c.fn === 'run').length, 0, 'no query issued');
});

test('releaseConferenceClaim on a personal job frees the slot but wakes nobody', async () => {
    resetState();
    state.allRows = [{ org_id: null, conference_record: 'conferenceRecords/cr1' }];
    const woken = await store.releaseConferenceClaim('id-a');
    assert.strictEqual(woken, 0);
    const runs = state.calls.filter(c => c.fn === 'run');
    assert.strictEqual(runs.length, 1, 'only the claim-clearing update');
    assert.match(norm(runs[0].sql), /SET conference_record = NULL/);
});
