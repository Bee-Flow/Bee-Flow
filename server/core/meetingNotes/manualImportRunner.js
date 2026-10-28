// @typecheck strict
/**
 * Runs a manual meeting import (Teams, Google Meet) after the HTTP answer.
 *
 * The import is minutes of Graph/Drive calls, an ffmpeg pass and a
 * transcription: far longer than any proxy keeps a request open (the
 * Kubernetes ingress cuts it at 60 s with a 504). The routes therefore seed the
 * job, answer 202 with its id and hand the work to `runDetached`; the client
 * polls the job list (`/teams-imports`, `/gmeet-imports`) until the job is
 * `ingested` or carries an error code. Outcomes are written to the job row by
 * the import pipeline itself; `runDetached` only guarantees that a failure
 * which escaped it is recorded too.
 *
 * Bookkeeping is per process (a Set of running job ids and two counters):
 * it stops a double click from starting the same import twice and caps how
 * many imports one user / organisation runs at once on this replica.
 *
 * Env (0 = unlimited):
 *   MEETING_IMPORT_MAX_CONCURRENT_PER_USER  default 3
 *   MEETING_IMPORT_MAX_CONCURRENT_PER_ORG   default 10
 */

const log = require('../../telemetry/log');

/**
 * @param {string} name
 * @param {number} fallback
 */
function limitFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** @type {Set<string>} */
const runningJobs = new Set();
/** @type {Map<string, number>} */
const perUser = new Map();
/** @type {Map<string, number>} */
const perOrg = new Map();

/**
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} delta
 */
function bump(map, key, delta) {
    const next = (map.get(key) || 0) + delta;
    if (next <= 0) map.delete(key); else map.set(key, next);
}

/**
 * Reserve a slot for one import. Synchronous, so two clicks cannot both pass.
 * @param {{ jobKey: string, userId: string, orgId?: string | null }} args
 * @returns {{ ok: true, release: () => void } | { ok: false, reason: 'already_running' | 'user_limit' | 'org_limit' }}
 */
function acquire({ jobKey, userId, orgId = null }) {
    if (runningJobs.has(jobKey)) return { ok: false, reason: 'already_running' };
    const userMax = limitFromEnv('MEETING_IMPORT_MAX_CONCURRENT_PER_USER', 3);
    const orgMax = limitFromEnv('MEETING_IMPORT_MAX_CONCURRENT_PER_ORG', 10);
    if (userMax > 0 && (perUser.get(userId) || 0) >= userMax) return { ok: false, reason: 'user_limit' };
    if (orgId && orgMax > 0 && (perOrg.get(orgId) || 0) >= orgMax) return { ok: false, reason: 'org_limit' };
    runningJobs.add(jobKey);
    bump(perUser, userId, 1);
    if (orgId) bump(perOrg, orgId, 1);
    let released = false;
    return {
        ok: true,
        release() {
            if (released) return;
            released = true;
            runningJobs.delete(jobKey);
            bump(perUser, userId, -1);
            if (orgId) bump(perOrg, orgId, -1);
        },
    };
}

/**
 * Run `work` detached from the request. Never rejects: a failure goes to
 * `onFailure` (which writes it on the job row) and to the log.
 * @param {{ label: string, release: () => void, work: () => Promise<unknown>, onFailure: (err: unknown) => Promise<unknown> }} args
 * @returns {Promise<void>} resolves when the work and its bookkeeping are done (tests await it; routes do not)
 */
async function runDetached({ label, release, work, onFailure }) {
    try {
        await work();
    } catch (err) {
        const e = /** @type {{ code?: string, message?: string }} */ (err);
        log.warn(`[${label}] background import failed${e?.code ? ` (${e.code})` : ''}: ${e?.message}`);
        try { await onFailure(err); } catch (recordErr) {
            log.error(`[${label}] could not record the import failure:`, /** @type {Error} */ (recordErr)?.message);
        }
    } finally {
        release();
    }
}

/** Clear the counters (tests). */
function _resetForTests() {
    runningJobs.clear(); perUser.clear(); perOrg.clear();
}

module.exports = { acquire, runDetached, _resetForTests };
