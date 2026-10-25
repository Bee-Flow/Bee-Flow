/** @typedef {import('pg').PoolClient} PoolClient */
// @typecheck
/**
 * The runner's lock-guarded background passes (extracted from ./ticks.js,
 * which mounts them): event polling and subscription renewal, Talk
 * auto-record, Teams auto-import, run-history and datatable retention, the
 * notification digest and the queued form-work sweep.
 *
 * Every pass but the form-work sweep runs on at most one pod per tick: it
 * holds its own Postgres advisory lock (underAdvisoryLock) and backs off
 * cleanly when another pod owns it. Errors are logged, never thrown, so a
 * failing pass never ends the tick.
 */

'use strict';

const { pool } = require('../../../db');
// What the passes drive in automation/, jobs/ and meeting notes: see ../featurePorts.js.
const { runnerPort } = require('../featurePorts');
const { reapOrphanFormUploads, reapExpiredGeneratedFiles, reapExpiredRunTables } = require('./reapers');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * Run `run` only when this pod takes the advisory lock `key`; another pod
 * owning it means this tick is theirs. The lock is released (best-effort) and
 * the client returned whatever happens; an error is logged under `label`.
 * @param {number} key
 * @param {string} label
 * @param {() => Promise<unknown>} run
 */
async function underAdvisoryLock(key, label, run) {
    let acquired = false;
    /** @type {PoolClient} */
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await run();
    } catch (e) {
        log.error(`[AutomationRunner] ${label} error:`, /** @type {Error} */ (e).message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [key]); } catch (err) { bestEffort('core/automationRunner/scheduler/passes:underAdvisoryLock', err); /* lock release is best-effort */ }
            client.release();
        }
    }
}

// ── Polling / renewal tick ──────────────────────────────
//
// Multi-pod safety: polling and renewal both write to the
// `automation_event_subscriptions` table and dispatch event runs. With
// multiple pods all running the same setInterval, two pods would race for
// the same subscriptions and could double-fire events. We guard the tick
// with a Postgres advisory lock — at most one pod runs polling at any
// instant. If the lock-holder crashes Postgres releases it on session end
// (the next tick on any pod re-acquires).
//
// We don't lock schedule processing (that uses FOR UPDATE SKIP LOCKED so
// it's already safe), and we don't lock per-subscription (one global lock
// keeps the implementation trivial; polling work is small enough that a
// single pod can handle it for the foreseeable future).

const POLLING_LOCK_KEY = 0xBEEF105; // arbitrary stable int for pg_try_advisory_lock

async function processPollingAndRenewals() {
    await underAdvisoryLock(POLLING_LOCK_KEY, 'polling/renewal', async () => {
        const triggerBus = runnerPort('triggerBus');
        await triggerBus.runPollingPass();
        await triggerBus.renewExpiringSubscriptions();
    });
}

// Talk auto-record: poll active Talk calls of opted-in users and start
// recording the ones they moderate. Single-pod-per-tick via its own advisory
// lock (same discipline as polling — a different stable key).
const TALK_AUTORECORD_LOCK_KEY = 0xBEEF106;

async function processTalkAutoRecord() {
    await underAdvisoryLock(TALK_AUTORECORD_LOCK_KEY, 'talk auto-record', async () => {
        await runnerPort('meetingImports').talkScanAndRecord();
    });
}

// Microsoft Teams auto-import: same two-phase shape as Google Meet (./gmeetImportTick.js), with
// its own lock key so the two discoveries never wait on each other.
const TEAMS_IMPORT_LOCK_KEY = 0xBEEF113; // 0xBEEF105–0xBEEF112 are all taken (0xBEEF10A by the ISO evidence collector)

async function processTeamsAutoImport() {
    const port = runnerPort('meetingImports');
    const teamsAutoImport = { discover: port.teamsDiscover, processDue: port.teamsProcessDue };
    await underAdvisoryLock(TEAMS_IMPORT_LOCK_KEY, 'teams auto-import discovery', () => teamsAutoImport.discover());
    try {
        await teamsAutoImport.processDue();
    } catch (e) {
        log.error('[AutomationRunner] teams auto-import ingest error:', /** @type {Error} */ (e).message);
    }
}

// §WS3.1 — run-history retention sweep. Advisory-locked so only one pod drains
// the backlog per tick (the DELETE is safe concurrently, but one pod is enough).
const RETENTION_LOCK_KEY = 0xBEEF107;

async function processRunRetention() {
    await underAdvisoryLock(RETENTION_LOCK_KEY, 'run-retention', async () => {
            await runnerPort('periodicJobs').runRetentionPass();
            // Automations in the trash past their 30 days (handoff 5). Same shape of
            // work as the pass above — bounded, idempotent, one pod — so it
            // shares this tick and its lock. Never lets a failure end the tick.
            try {
                await runnerPort('periodicJobs').purgeTrashPass();
            } catch (e) {
                log.warn('[AutomationRunner] trash purge failed:', /** @type {Error} */ (e).message);
            }
            // Monitoring ledgers and the PII scan ledger do NOT ride this tick:
            // chat and DLP fill them whether or not Automations is installed, so
            // they run from jobs/platformRetention.js, ungated (BFSF-439).
            //
            // Form-trigger uploads that never reached a submission (visitor closed
            // the tab after picking a file). Rides this tick because it is the same
            // shape of work: bounded, idempotent, one pod.
            await reapOrphanFormUploads();
            await reapExpiredGeneratedFiles();
            await reapExpiredRunTables();
            // Visitor sessions for multi-page forms. Purely a pointer row, so this
            // is a plain delete — the run it referenced has its own retention.
            try {
                const n = await require('../../../stores/automationStore').deleteExpiredFormSessions(500);
                if (n) log.info(`[AutomationRunner] reaped ${n} expired form session(s)`);
            } catch (e) {
                log.warn('[AutomationRunner] form-session reap failed:', /** @type {Error} */ (e).message);
            }
    });
}

// Datatable row retention. Its own tick and its own lock, and DELIBERATELY NOT
// wrapped in moduleGatedTick — see the header of jobs/datatableRetention.js.
// A module gate re-reads the runtime module row on every invocation, so the
// moment an org's Automations module is switched off (or its licence lapses)
// deletion would stop while the personal data stayed and the Studio kept
// promising "deleted after N days". A retention obligation must not be gated on
// a billable feature.
//
// The lock is HERE rather than in the job because that is where every other
// pass keeps it (processRunRetention, polling, talk, gmeet): the job's own
// header claims a lock, and this is the line that makes that claim true.
const DATATABLE_RETENTION_LOCK_KEY = 0xBEEF10E;

async function processDatatableRetention() {
    await underAdvisoryLock(DATATABLE_RETENTION_LOCK_KEY, 'datatable-retention', async () => {
        await runnerPort('periodicJobs').datatableRetentionPass();
    });
}

// Automation notifications that wait: throttled messages bundled into one
// "n more", and the daily summary (jobs/automationDigest.js, handoff 5).
// Five minutes keeps a 17:00 summary within minutes of 17:00. One pod.
const NOTIFICATION_DIGEST_LOCK_KEY = 0xBEEF112;
const NOTIFICATION_DIGEST_INTERVAL_MS = 5 * 60_000;

// Form submissions that were accepted (202) but whose pod died before their
// run started: the work is on the session row, and a lapsed lease means no
// live pod holds it. Every pod sweeps — the claim is atomic (SKIP LOCKED), so
// no lock is needed. See automation/formQueue.js.
async function processQueuedFormWork() {
    try {
        await runnerPort('formQueue').recoverPending();
    } catch (e) {
        log.warn('[AutomationRunner] form-queue recovery failed:', /** @type {Error} */ (e).message);
    }
}

async function processNotificationDigest() {
    await underAdvisoryLock(NOTIFICATION_DIGEST_LOCK_KEY, 'notification digest', async () => {
        await runnerPort('periodicJobs').digestPass();
    });
}

module.exports = {
    processPollingAndRenewals,
    processTalkAutoRecord,
    processTeamsAutoImport,
    processRunRetention,
    processDatatableRetention,
    processQueuedFormWork,
    processNotificationDigest,
    NOTIFICATION_DIGEST_INTERVAL_MS,
};
