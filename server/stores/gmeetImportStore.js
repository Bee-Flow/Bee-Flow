// @typecheck
/**
 * Gmeet Import Store — PostgreSQL-backed Google Meet ingest job queue.
 *
 * One row per (user, calendar event / conference record) candidate meeting.
 * The discovery poller seeds rows; the ingest worker claims due rows with
 * FOR UPDATE SKIP LOCKED (pattern: automationStore claimDueAutomations) so
 * concurrent server instances never download the same recording twice.
 *
 * Status machine:
 *   pending → awaiting_artifacts → ingested
 *   terminal: no_conference | no_recording | no_drive_access |
 *             recording_too_large | failed | duplicate | skipped
 *   parked:   needs_reauth (excluded from claims until unparked)
 *
 * The partial unique index on (org_id, conference_record) is the org-level
 * ingest claim: when several attendees of the same org have a job for the
 * same conference, only the first attachConferenceRecord wins — the others
 * get { duplicate: true } and defer (organizer-first: seed marks the
 * organizer's job `preferred` so it is claimed ahead of attendees').
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');

const initDB = makeStoreInit('GmeetImportStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS gmeet_import_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            org_id TEXT,
            calendar_event_id TEXT,
            ical_uid TEXT,
            meeting_code TEXT NOT NULL,
            space_name TEXT,
            conference_record TEXT,
            title TEXT,
            meeting_start TIMESTAMPTZ,
            meeting_end TIMESTAMPTZ,
            preferred BOOLEAN NOT NULL DEFAULT false,
            status TEXT NOT NULL DEFAULT 'pending',
            error_code TEXT,
            last_error TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            transcription_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_gmeet_jobs_user_event
            ON gmeet_import_jobs(user_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_gmeet_jobs_user_conference
            ON gmeet_import_jobs(user_id, conference_record) WHERE conference_record IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_gmeet_jobs_org_conference
            ON gmeet_import_jobs(org_id, conference_record) WHERE conference_record IS NOT NULL AND org_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_gmeet_jobs_due
            ON gmeet_import_jobs(next_attempt_at) WHERE status IN ('pending', 'awaiting_artifacts');
    `);

    // Migrations — additive, idempotent `ALTER TABLE ... ADD COLUMN IF NOT
    // EXISTS` statements go here so old deployments pick up new columns on
    // boot (pattern: transcriptionStore). None yet — the table is new.
    log.info('[GmeetImportStore] PostgreSQL initialized');
}

function mapJob(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        orgId: r.org_id || null,
        calendarEventId: r.calendar_event_id || null,
        icalUid: r.ical_uid || null,
        meetingCode: r.meeting_code,
        spaceName: r.space_name || null,
        conferenceRecord: r.conference_record || null,
        title: r.title || null,
        meetingStart: r.meeting_start ? new Date(r.meeting_start).toISOString() : null,
        meetingEnd: r.meeting_end ? new Date(r.meeting_end).toISOString() : null,
        preferred: !!r.preferred,
        status: r.status,
        errorCode: r.error_code || null,
        lastError: r.last_error || null,
        attempts: r.attempts || 0,
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
        transcriptionId: r.transcription_id || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

/**
 * Seed a job for a discovered meeting. Idempotent per (user, calendar event):
 * re-discovery of an already-seeded event returns null instead of a new row.
 * A unique violation on the conference-record indexes (seeding a recently
 * ended conference another job already covers) also returns null.
 */
async function seedJob({ userId, orgId = null, calendarEventId = null, icalUid = null, meetingCode, spaceName = null, conferenceRecord = null, title = null, meetingStart = null, meetingEnd = null, preferred = false, status = 'pending', nextAttemptAt = null }) {
    await initDB();
    try {
        const { rows } = await run(
            `INSERT INTO gmeet_import_jobs
                (user_id, org_id, calendar_event_id, ical_uid, meeting_code, space_name, conference_record,
                 title, meeting_start, meeting_end, preferred, status, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, NOW()))
             ON CONFLICT (user_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL DO NOTHING
             RETURNING *`,
            [userId, orgId, calendarEventId, icalUid, meetingCode, spaceName, conferenceRecord,
                title, meetingStart, meetingEnd, !!preferred, status, nextAttemptAt],
        );
        return rows && rows[0] ? mapJob(rows[0]) : null;
    } catch (e) {
        if (e && e.code === '23505') return null;
        throw e;
    }
}

/**
 * Atomically claim due jobs for ingest. FOR UPDATE SKIP LOCKED so concurrent
 * workers never claim the same row; organizer jobs (`preferred`) go first.
 * The claim pushes next_attempt_at 10 minutes ahead as a lease — a crashed
 * worker's jobs become reclaimable instead of being lost.
 */
async function claimDueJobs(limit = 2) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT id FROM gmeet_import_jobs
             WHERE status IN ('pending', 'awaiting_artifacts')
               AND next_attempt_at <= NOW()
             ORDER BY preferred DESC, next_attempt_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit],
        );
        if (sel.rows.length === 0) {
            await client.query('COMMIT');
            return [];
        }
        const ids = sel.rows.map(r => r.id);
        const upd = await client.query(
            `UPDATE gmeet_import_jobs
                SET next_attempt_at = NOW() + INTERVAL '10 minutes',
                    updated_at = NOW()
              WHERE id = ANY($1::uuid[])
              RETURNING *`,
            [ids],
        );
        await client.query('COMMIT');
        return upd.rows.map(mapJob);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Extend a running job's lease.
 *
 * The claim above only pushes `next_attempt_at` ten minutes out, but the work
 * it guards — download a Meet recording from Drive, transcribe it, then five to
 * seven LLM passes — routinely takes far longer than that on a real meeting. So
 * the lease expired mid-ingest, the next 120-second tick re-claimed the same
 * job on another replica, and the whole pipeline ran a second (or third) time.
 * Only the first `createTranscription` survives `ON CONFLICT (source_uri)`; all
 * the other Drive bandwidth, transcription minutes and LLM calls were paid for
 * and thrown away.
 *
 * Called between pipeline stages, so a genuinely crashed worker still loses its
 * lease and the job is still recovered — it is the LIVE work that keeps it.
 *
 * @returns {Promise<boolean>} false when the job no longer exists.
 */
async function heartbeatJob(id, minutes = 10) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE gmeet_import_jobs
            SET next_attempt_at = NOW() + ($2::int * INTERVAL '1 minute'),
                updated_at = NOW()
          WHERE id = $1`,
        [id, minutes],
    );
    return rowCount > 0;
}

/**
 * Record the resolved space/conference for a job. Returns the updated job,
 * or `{ duplicate: true }` when the (org_id, conference_record) org-claim
 * index rejects it — i.e. another attendee's job already owns this
 * conference and this one should be marked `duplicate` by the caller.
 */
async function attachConferenceRecord(id, { spaceName = null, conferenceRecord }) {
    await initDB();
    try {
        const { rows } = await run(
            `UPDATE gmeet_import_jobs
                SET space_name = COALESCE($2, space_name),
                    conference_record = $3,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [id, spaceName, conferenceRecord],
        );
        return rows && rows[0] ? mapJob(rows[0]) : null;
    } catch (e) {
        if (e && e.code === '23505') return { duplicate: true };
        throw e;
    }
}

/**
 * Give up this job's org-level claim on a conference and wake the attendees'
 * jobs that were parked behind it.
 *
 * The `(org_id, conference_record)` index means exactly one attendee's job may
 * own a conference; the rest are set to `duplicate` and wait for the owner to
 * produce the note. Nothing ever unparked them, so when the owner failed
 * terminally — expired Google token, deleted Drive file, a transcription
 * provider outage — every other attendee's job stayed `duplicate` forever and
 * the meeting simply produced no note for anyone, with no error surfaced to
 * the people still waiting.
 *
 * Clearing `conference_record` frees the index slot, so a woken sibling can
 * re-resolve the conference and claim it. Only siblings still parked with no
 * note of their own are woken.
 *
 * @returns {Promise<number>} how many siblings were returned to `pending`
 */
async function releaseConferenceClaim(id) {
    await initDB();
    const job = await getOne('SELECT org_id, conference_record FROM gmeet_import_jobs WHERE id = $1', [id]);
    if (!job || !job.conference_record) return 0;

    await run(
        `UPDATE gmeet_import_jobs SET conference_record = NULL, updated_at = NOW() WHERE id = $1`,
        [id],
    );
    if (!job.org_id) return 0;

    const { rowCount } = await run(
        `UPDATE gmeet_import_jobs
            SET status = 'pending',
                error_code = NULL,
                next_attempt_at = NOW(),
                updated_at = NOW()
          WHERE org_id = $1
            AND id <> $2
            AND status = 'duplicate'
            AND transcription_id IS NULL
            AND conference_record IS NULL
            AND (meeting_code = (SELECT meeting_code FROM gmeet_import_jobs WHERE id = $2)
                 OR space_name = (SELECT space_name FROM gmeet_import_jobs WHERE id = $2))`,
        [job.org_id, id],
    );
    return rowCount || 0;
}

const UPDATABLE_FIELDS = {
    status: 'status',
    errorCode: 'error_code',
    lastError: 'last_error',
    attempts: 'attempts',
    nextAttemptAt: 'next_attempt_at',
    transcriptionId: 'transcription_id',
    title: 'title',
    meetingStart: 'meeting_start',
    meetingEnd: 'meeting_end',
    spaceName: 'space_name',
    conferenceRecord: 'conference_record',
    preferred: 'preferred',
    icalUid: 'ical_uid',
};

async function updateJob(id, fields) {
    await initDB();
    const built = buildUpdate({
        table: 'gmeet_import_jobs',
        updates: fields,
        columnMap: UPDATABLE_FIELDS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

async function completeJob(id, transcriptionId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE gmeet_import_jobs
            SET status = 'ingested',
                transcription_id = $2,
                error_code = NULL,
                last_error = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [id, transcriptionId],
    );
    return rowCount > 0;
}

/**
 * Record a failed attempt. `terminal` freezes the job in its error status
 * (the error code doubles as the status, e.g. `no_drive_access`);
 * non-terminal schedules a retry after `backoffMs` and keeps — or, when
 * `status` is passed, restores — the claimable status
 * ('pending' | 'awaiting_artifacts').
 */
async function failJob(id, { errorCode = null, lastError = null, terminal = false, backoffMs = 0, status = null } = {}) {
    await initDB();
    if (terminal) {
        const { rowCount } = await run(
            `UPDATE gmeet_import_jobs
                SET attempts = attempts + 1,
                    status = $2,
                    error_code = $3,
                    last_error = $4,
                    updated_at = NOW()
              WHERE id = $1`,
            [id, errorCode || 'failed', errorCode, lastError],
        );
        return rowCount > 0;
    }
    const { rowCount } = await run(
        `UPDATE gmeet_import_jobs
            SET attempts = attempts + 1,
                status = COALESCE($2, status),
                error_code = $3,
                last_error = $4,
                next_attempt_at = NOW() + ($5 * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE id = $1`,
        [id, status, errorCode, lastError, backoffMs],
    );
    return rowCount > 0;
}

/**
 * Park a job until the user re-authorizes Google. Parked jobs are excluded
 * from claims (status filter); `nextAttemptAt` records when the poller may
 * flip it back to pending after re-auth.
 */
async function parkNeedsReauth(id, nextAttemptAt) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE gmeet_import_jobs
            SET status = 'needs_reauth',
                error_code = 'needs_reauth',
                next_attempt_at = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [id, nextAttemptAt],
    );
    return rowCount > 0;
}

/**
 * Recent jobs for the failure-UX feed / import panel.
 */
async function listRecentJobsForUser(userId, days = 7) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM gmeet_import_jobs
         WHERE user_id = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')
         ORDER BY created_at DESC`,
        [userId, days],
    );
    return rows.map(mapJob);
}

async function getJob(id) {
    await initDB();
    const r = await getOne('SELECT * FROM gmeet_import_jobs WHERE id = $1', [id]);
    return mapJob(r);
}

module.exports = {
    initDB,
    seedJob,
    claimDueJobs,
    heartbeatJob,
    attachConferenceRecord,
    releaseConferenceClaim,
    updateJob,
    completeJob,
    failJob,
    parkNeedsReauth,
    listRecentJobsForUser,
    getJob,
};
