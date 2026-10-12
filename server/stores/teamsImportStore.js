// @typecheck
/**
 * Teams Import Store — PostgreSQL-backed Microsoft Teams ingest job queue.
 *
 * One row per (user, calendar occurrence). Same claim discipline as
 * gmeetImportStore (FOR UPDATE SKIP LOCKED, a lease on next_attempt_at, a
 * heartbeat for the long ingest stage), but without its org-level conference
 * claim: Graph only gives recordings to the ORGANIZER under delegated
 * permissions, and discovery only seeds organizer jobs, so one meeting
 * occurrence never has two competing jobs. The note's `source_uri` dedups
 * anything that slips through.
 *
 * Status machine:
 *   pending → awaiting_artifacts → ingested
 *   terminal: no_recording | not_organizer | recording_too_large |
 *             transcript_access_disabled | failed | skipped
 *   parked:   needs_reauth (excluded from claims until unparked)
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');

const initDB = makeStoreInit('TeamsImportStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS teams_import_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            org_id TEXT,
            calendar_event_id TEXT NOT NULL,
            series_master_id TEXT,
            join_url TEXT NOT NULL,
            online_meeting_id TEXT,
            title TEXT,
            meeting_start TIMESTAMPTZ,
            meeting_end TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'pending',
            error_code TEXT,
            last_error TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            transcription_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_jobs_user_event
            ON teams_import_jobs(user_id, calendar_event_id);
        CREATE INDEX IF NOT EXISTS idx_teams_jobs_due
            ON teams_import_jobs(next_attempt_at) WHERE status IN ('pending', 'awaiting_artifacts');
    `);
    log.info('[TeamsImportStore] PostgreSQL initialized');
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

function mapJob(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        orgId: r.org_id || null,
        calendarEventId: r.calendar_event_id,
        seriesMasterId: r.series_master_id || null,
        joinUrl: r.join_url,
        onlineMeetingId: r.online_meeting_id || null,
        title: r.title || null,
        meetingStart: iso(r.meeting_start),
        meetingEnd: iso(r.meeting_end),
        status: r.status,
        errorCode: r.error_code || null,
        lastError: r.last_error || null,
        attempts: r.attempts || 0,
        nextAttemptAt: iso(r.next_attempt_at),
        transcriptionId: r.transcription_id || null,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
    };
}

/**
 * Seed a job for a discovered occurrence. Idempotent per (user, event):
 * returns null when the row already exists.
 */
async function seedJob({ userId, orgId = null, calendarEventId, seriesMasterId = null, joinUrl, title = null, meetingStart = null, meetingEnd = null }) {
    await initDB();
    const { rows } = await run(
        `INSERT INTO teams_import_jobs
            (user_id, org_id, calendar_event_id, series_master_id, join_url, title, meeting_start, meeting_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, calendar_event_id) DO NOTHING
         RETURNING *`,
        [userId, orgId, calendarEventId, seriesMasterId, joinUrl, title, meetingStart, meetingEnd],
    );
    return rows && rows[0] ? mapJob(rows[0]) : null;
}

/** Claim due jobs; the claim leases each row for 10 minutes. */
async function claimDueJobs(limit = 2) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT id FROM teams_import_jobs
             WHERE status IN ('pending', 'awaiting_artifacts')
               AND next_attempt_at <= NOW()
             ORDER BY next_attempt_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit],
        );
        if (sel.rows.length === 0) {
            await client.query('COMMIT');
            return [];
        }
        const upd = await client.query(
            `UPDATE teams_import_jobs
                SET next_attempt_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
              WHERE id = ANY($1::uuid[])
              RETURNING *`,
            [sel.rows.map(r => r.id)],
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

/** Extend a running job's lease (see gmeetImportStore.heartbeatJob for why). */
async function heartbeatJob(id, minutes = 10) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE teams_import_jobs
            SET next_attempt_at = NOW() + ($2::int * INTERVAL '1 minute'), updated_at = NOW()
          WHERE id = $1`,
        [id, minutes],
    );
    return rowCount > 0;
}

const UPDATABLE_FIELDS = {
    status: 'status',
    errorCode: 'error_code',
    lastError: 'last_error',
    nextAttemptAt: 'next_attempt_at',
    transcriptionId: 'transcription_id',
    onlineMeetingId: 'online_meeting_id',
    title: 'title',
};

async function updateJob(id, fields) {
    await initDB();
    const built = buildUpdate({
        table: 'teams_import_jobs',
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
        `UPDATE teams_import_jobs
            SET status = 'ingested', transcription_id = $2, error_code = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id, transcriptionId],
    );
    return rowCount > 0;
}

/**
 * Record a failed attempt. `terminal` freezes the job with the error code as
 * its status; otherwise it is retried after `backoffMs` in `status`.
 */
async function failJob(id, { errorCode = null, lastError = null, terminal = false, backoffMs = 0, status = null } = {}) {
    await initDB();
    if (terminal) {
        const { rowCount } = await run(
            `UPDATE teams_import_jobs
                SET attempts = attempts + 1, status = $2, error_code = $3, last_error = $4, updated_at = NOW()
              WHERE id = $1`,
            [id, errorCode || 'failed', errorCode, lastError],
        );
        return rowCount > 0;
    }
    const { rowCount } = await run(
        `UPDATE teams_import_jobs
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

async function parkNeedsReauth(id) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE teams_import_jobs
            SET status = 'needs_reauth', error_code = 'needs_reauth', updated_at = NOW()
          WHERE id = $1`,
        [id],
    );
    return rowCount > 0;
}

/** Return a user's parked jobs to the queue once their credential works again. */
async function unparkForUser(userId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE teams_import_jobs
            SET status = 'pending', error_code = NULL, next_attempt_at = NOW(), updated_at = NOW()
          WHERE user_id = $1 AND status = 'needs_reauth'`,
        [userId],
    );
    return rowCount || 0;
}

async function listRecentJobsForUser(userId, days = 7) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM teams_import_jobs
         WHERE user_id = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')
         ORDER BY created_at DESC`,
        [userId, days],
    );
    return rows.map(mapJob);
}

async function getJobForEvent(userId, calendarEventId) {
    await initDB();
    return mapJob(await getOne(
        'SELECT * FROM teams_import_jobs WHERE user_id = $1 AND calendar_event_id = $2',
        [userId, calendarEventId],
    ));
}

async function getJob(id) {
    await initDB();
    return mapJob(await getOne('SELECT * FROM teams_import_jobs WHERE id = $1', [id]));
}

module.exports = {
    initDB,
    seedJob,
    claimDueJobs,
    heartbeatJob,
    updateJob,
    completeJob,
    failJob,
    parkNeedsReauth,
    unparkForUser,
    listRecentJobsForUser,
    getJobForEvent,
    getJob,
};
