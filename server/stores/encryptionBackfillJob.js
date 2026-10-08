'use strict';
/**
 * In-memory job state for "encrypt existing data" (stores/encryptionBackfill.js).
 *
 * PER PROCESS: this assumes a single server instance. A restart (or a second
 * instance) loses or never sees the state. That is acceptable because the
 * backfill itself is idempotent and resumable: already-encrypted rows are
 * skipped, so an admin can simply start it again.
 *
 * One job per org at a time. The state of a finished job is kept until the next
 * start for that org. The map is bounded; the oldest FINISHED entry is evicted
 * first, a running job is never evicted.
 */

const log = require('../telemetry/log');

const MAX_JOBS = 200;
/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {Function|null} test seam: replaces the real engine when set */
let defaultBackfillOrg = null;

const GENERIC_ERROR = 'The encryption run failed. See the server log for details.';

function idle() {
    return { status: 'idle', dryRun: null, startedAt: null, finishedAt: null, surfaces: {}, error: null };
}

function snapshot(job) {
    return { ...job, surfaces: JSON.parse(JSON.stringify(job.surfaces)) };
}

function get(orgId) {
    const job = jobs.get(String(orgId));
    return job ? snapshot(job) : idle();
}

function evictIfFull() {
    if (jobs.size < MAX_JOBS) return;
    for (const [k, v] of jobs) {
        if (v.status !== 'running') { jobs.delete(k); return; }
    }
}

/**
 * Start a job in the background.
 * @returns {{started: boolean, job: object}} started=false when one already runs.
 */
function start(orgId, dryRun, deps = {}) {
    const key = String(orgId);
    const existing = jobs.get(key);
    if (existing && existing.status === 'running') return { started: false, job: snapshot(existing) };

    const backfillOrg = deps.backfillOrg || defaultBackfillOrg || require('./encryptionBackfill').backfillOrg;
    const job = {
        status: 'running', dryRun: !!dryRun,
        startedAt: new Date().toISOString(), finishedAt: null, surfaces: {}, error: null,
    };
    jobs.delete(key);
    evictIfFull();
    jobs.set(key, job);

    Promise.resolve()
        .then(() => backfillOrg(key, {
            dryRun: !!dryRun,
            onProgress: (surface, stats) => { job.surfaces[surface] = { ...stats }; },
        }))
        .then((result) => {
            if (result && result.surfaces) {
                for (const [s, st] of Object.entries(result.surfaces)) job.surfaces[s] = { ...st };
            }
            job.status = 'done';
        })
        .catch((err) => {
            log.error(`[EncryptionBackfill] org '${key}' failed: ${err && err.message}`);
            job.status = 'error';
            job.error = GENERIC_ERROR;
        })
        .finally(() => { job.finishedAt = new Date().toISOString(); });

    return { started: true, job: snapshot(job) };
}

/** Test helpers. */
function _reset() { jobs.clear(); defaultBackfillOrg = null; }
function _setDefaultBackfillOrg(fn) { defaultBackfillOrg = fn; }

module.exports = { start, get, _reset, _setDefaultBackfillOrg, GENERIC_ERROR };
