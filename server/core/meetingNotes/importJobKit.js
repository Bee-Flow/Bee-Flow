// @typecheck strict
/**
 * The job plumbing the meeting-note engines share: gmeetAutoImport and
 * teamsAutoImport (discover -> seed jobs -> claim -> ingest), and the
 * candidate-user scan talkAutoRecord also runs. Each engine keeps what is
 * its own (provider calls, settings, per-job pipeline); this module holds the
 * parts that were copied between them, with the same timings and log lines.
 *
 *   listCandidateUsers  users with their own `user_<kind>_*` settings doc, plus
 *                       the members of orgs whose `org_<kind>_*` doc turned the
 *                       feature on
 *   makeDiscovery       a round-robin, jittered pass over at most N candidates
 *                       per tick (the caller holds the advisory lock)
 *   failIngest          classify an ingest failure into terminal / retry
 *   failLookup          the same for the provider lookups before the ingest,
 *                       bounded by a deadline after the meeting
 *   processDueJobs      claim due jobs one at a time and run each, logging
 *                       expected outcomes quietly
 *   withLeaseHeartbeat  keep a running job's lease renewed
 *   isIngestInFlight    does a live run hold this job (seen from its row)?
 */

'use strict';

const log = require('../../telemetry/log');
const { fallback, bestEffort } = require('../../utils/bestEffort');

// Artifact wait/retry backoff, indexed by the job's attempt count; past the
// end of the table the poller settles into an hourly re-check.
const BACKOFF_MINUTES = [2, 5, 10, 20, 40];
const HOURLY_MS = 60 * 60_000;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} message
 * @param {string} code
 */
function codedError(message, code) {
    const e = /** @type {Error & {code?: string}} */ (new Error(message));
    e.code = code;
    return e;
}

/** @param {number} [attempts] */
function backoffMsFor(attempts) {
    const min = BACKOFF_MINUTES[Math.max(0, attempts || 0)];
    return min != null ? min * 60_000 : HOURLY_MS;
}

/** The meeting's end, else the job's creation, else now (ms). */
function meetingEndMs(/** @type {{ meetingEnd?: string | Date | null, createdAt?: string | Date | null }} */ job) {
    const end = job.meetingEnd ? new Date(job.meetingEnd).getTime() : NaN;
    if (Number.isFinite(end)) return end;
    const created = job.createdAt ? new Date(job.createdAt).getTime() : NaN;
    return Number.isFinite(created) ? created : Date.now();
}

// `lastError` carries an "attempt N/M:" marker so ingest retries are counted
// across claims — job.attempts also counts artifact waits, which must not eat
// into the ingest retry budget.
function ingestAttempt(/** @type {{ errorCode?: string | null, lastError?: string | null }} */ job) {
    if (job.errorCode !== 'failed') return 0;
    const m = /^attempt (\d+)\//.exec(job.lastError || '');
    return m ? Number(m[1]) : 1;
}

/**
 * @param {string} userId
 * @param {() => any} getUserStore  loaded inside the try: a store that fails
 *   to load counts as "no org", as before
 * @returns {Promise<string|null>}
 */
async function resolveOrgIdForUser(userId, getUserStore) {
    try {
        return (await getUserStore().getUser(userId))?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * `kind` is the settings-doc infix (e.g. 'gmeet_notes'); `flag` the setting
 * that turns the feature on for an org.
 *
 * @param {{
 *   configStore: { getAllConfig: () => Promise<Record<string, any>> },
 *   kind: string,
 *   resolveSettings: (args: { orgId: string }) => Promise<any>,
 *   flag: string,
 *   getUserStore: () => any,
 * }} opts
 * @returns {Promise<string[]>}
 */
async function listCandidateUsers({ configStore, kind, resolveSettings, flag, getUserStore }) {
    const userPrefix = `user_${kind}_`;
    const orgPrefix = `org_${kind}_`;
    const all = await configStore.getAllConfig().catch((e) => fallback('core/meetingNotes/importJobKit:listCandidateUsers', e, {}));
    const userIds = new Set();
    const orgIds = new Set();
    for (const key of Object.keys(all || {})) {
        if (key.startsWith(userPrefix)) userIds.add(key.slice(userPrefix.length));
        else if (key.startsWith(orgPrefix)) orgIds.add(key.slice(orgPrefix.length));
    }
    if (orgIds.size) {
        const enabledOrgs = [];
        for (const orgId of orgIds) {
            const s = await resolveSettings({ orgId }).catch((e) => fallback('core/meetingNotes/importJobKit:listCandidateUsers#2', e, null));
            if (s?.[flag]) enabledOrgs.push(orgId);
        }
        if (enabledOrgs.length) {
            try {
                const users = await getUserStore().getAllUsers();
                for (const u of users) {
                    if (u.organizationId && enabledOrgs.includes(u.organizationId)) userIds.add(u.id);
                }
            } catch (err) { bestEffort('core/meetingNotes/importJobKit:listCandidateUsers#3', err); /* best-effort */ }
        }
    }
    return Array.from(userIds);
}

/**
 * Phase A of an import engine: walk at most `maxUsersPerTick` candidates,
 * continuing where the previous tick stopped (a large install fans out over
 * successive ticks), with a random pause between users to spread the
 * provider's quota.
 *
 * @param {{
 *   label: string,
 *   maxUsersPerTick: number,
 *   jitterMs: number,
 *   listCandidateUsers: () => Promise<string[]>,
 *   discoverUser: (userId: string) => Promise<void>,
 * }} opts
 * @returns {() => Promise<void>}
 */
function makeDiscovery({ label, maxUsersPerTick, jitterMs, listCandidateUsers: listUsers, discoverUser }) {
    let userCursor = 0;
    return async function discover() {
        /** @type {string[]} */
        let users;
        try { users = await listUsers(); }
        catch (e) { log.error(`[${label}] candidate scan failed:`, /** @type {Error} */ (e).message); return; }
        if (!users.length) return;

        const count = Math.min(users.length, maxUsersPerTick);
        const start = userCursor % users.length;
        userCursor = (start + count) % users.length;
        for (let i = 0; i < count; i++) {
            const userId = users[(start + i) % users.length];
            // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- scheduling jitter between users, not a secret
            if (i > 0) await sleep(Math.floor(Math.random() * jitterMs));
            try { await discoverUser(userId); }
            catch (e) { log.error(`[${label}] discovery failed for user ${userId}: ${/** @type {Error} */ (e).message}`); }
        }
    };
}

/**
 * Record a failed ingest on the job and throw. Classified codes in
 * `terminalCodes` freeze the job under that code (and rethrow the original
 * error); anything else retries up to `maxAttempts` with backoff, then freezes
 * as 'failed', and throws a 'failed' coded error. `onTerminal` runs after a
 * job froze.
 *
 * @param {{
 *   store: { failJob: (id: string, opts: any) => Promise<any> },
 *   job: any,
 *   err: any,
 *   terminalCodes: Set<string>,
 *   maxAttempts: number,
 *   fallbackMessage: string,
 *   onTerminal?: (job: any) => Promise<void>,
 *   keepCode?: boolean,
 * }} opts
 * @returns {Promise<never>}
 */
async function failIngest({ store, job, err, terminalCodes, maxAttempts, fallbackMessage, onTerminal, keepCode = false }) {
    const code = err?.code || null;
    if (code && terminalCodes.has(code)) {
        await store.failJob(job.id, { errorCode: code, terminal: true, lastError: err.message });
        if (onTerminal) await onTerminal(job);
        throw err;
    }
    const attempt = ingestAttempt(job) + 1;
    const lastError = `attempt ${attempt}/${maxAttempts}: ${String(err?.message || err).slice(0, 500)}`;
    if (attempt >= maxAttempts) {
        await freezeFailedIngest({ store, job, err, lastError, keepCode, onTerminal });
    } else {
        await store.failJob(job.id, {
            errorCode: 'failed', lastError,
            terminal: false, status: 'pending',
            backoffMs: backoffMsFor(job.attempts),
        });
    }
    throw codedError(err?.message || fallbackMessage, 'failed');
}

/** A pipeline's own failure code (summary_empty, no_recording), never a system one. */
const CLASSIFIED_CODE_RE = /^[a-z][a-z_]+$/;

/**
 * The last allowed ingest attempt failed: freeze the job. With `keepCode` it
 * keeps the pipeline's own classified code (lower-case snake_case, such as
 * `summary_empty`) instead of the generic 'failed', and the original error is
 * rethrown so the caller sees that code. A system code (`ECONNRESET`,
 * `UND_ERR_HEADERS_TIMEOUT`) is no job status and becomes 'failed'.
 * @param {{ store: { failJob: (id: string, opts: any) => Promise<any> }, job: any, err: any, lastError: string,
 *   keepCode: boolean, onTerminal?: (job: any) => Promise<void> }} opts
 */
async function freezeFailedIngest({ store, job, err, lastError, keepCode, onTerminal }) {
    const code = err?.code;
    const finalCode = keepCode && typeof code === 'string' && CLASSIFIED_CODE_RE.test(code) ? code : 'failed';
    await store.failJob(job.id, { errorCode: finalCode, terminal: true, lastError });
    if (onTerminal) await onTerminal(job);
    if (finalCode !== 'failed') throw err;
}

/**
 * Phase B: claim due jobs (FOR UPDATE SKIP LOCKED, so every pod may run this)
 * and process each; a job's failure is logged, quietly for expected outcomes,
 * and never stops the rest.
 *
 * @param {{
 *   store: { claimDueJobs: (limit: number) => Promise<any[]> },
 *   limit: number,
 *   label: string,
 *   describe: (job: any) => string,
 *   processClaimedJob: (job: any) => Promise<void>,
 *   quietCodes: Set<string>,
 * }} opts
 */
async function processDueJobs({ store, limit, label, describe, processClaimedJob, quietCodes }) {
    // ONE claim per job, right before it runs. A batch claim put the same
    // 10-minute lease on every job at once and then ran them one after the
    // other: while the first ingested for half an hour, the second's lease ran
    // out, another replica claimed and ingested it, and this pod then ingested
    // it AGAIN from its stale claim.
    for (let i = 0; i < limit; i++) {
        let jobs;
        try { jobs = await store.claimDueJobs(1); }
        catch (e) { log.error(`[${label}] claim failed:`, /** @type {Error} */ (e).message); return; }
        const job = jobs[0];
        if (!job) return;
        try {
            await processClaimedJob(job);
        } catch (e) {
            const err = /** @type {Error & { code?: string }} */ (e);
            const code = err?.code || 'failed';
            const line = `[${label}] job ${describe(job)}: ${code}: ${err.message}`;
            if (quietCodes.has(code)) log.info(line); // expected outcome, no alarm
            else log.warn(line);
        }
    }
}

/**
 * Run `work` while renewing the job's lease. A single extension before a long
 * ingest ran out on a meeting that took longer than the lease, and another
 * replica claimed and ingested the job again while the first run was still
 * going. The lease is renewed every third of its length, so a live run always
 * holds it and a crashed worker still loses it within one lease.
 *
 * @template T
 * @param {{ store: { heartbeatJob: (id: string, minutes: number) => Promise<unknown> },
 *   jobId: string, leaseMinutes: number, label: string, work: () => Promise<T> }} opts
 * @returns {Promise<T>}
 */
async function withLeaseHeartbeat({ store, jobId, leaseMinutes, label, work }) {
    const beat = () => Promise.resolve(store.heartbeatJob(jobId, leaseMinutes))
        .catch((e) => log.warn(`[${label}] lease extension failed:`, /** @type {Error} */ (e).message));
    await beat();
    const everyMs = Math.max(60_000, Math.floor((leaseMinutes * 60_000) / 3));
    const timer = setInterval(() => { void beat(); }, everyMs);
    timer.unref?.();
    try {
        return await work();
    } finally {
        clearInterval(timer);
    }
}

/**
 * Is a run holding this job right now? A running ingest renews a lease of
 * `leaseMinutes` every third of it (withLeaseHeartbeat), so its row shows a
 * lease that long, written within the last renewal interval. A retry backoff
 * (at most an hour) or the 10-minute claim lease never looks like that, and a
 * crashed worker's row stops looking like it within one renewal.
 * @param {{ status?: string, nextAttemptAt?: string | Date | null, updatedAt?: string | Date | null }} job
 * @param {number} leaseMinutes
 */
function isIngestInFlight(job, leaseMinutes) {
    if (!job || !['pending', 'awaiting_artifacts'].includes(String(job.status))) return false;
    const next = job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : NaN;
    const updated = job.updatedAt ? new Date(job.updatedAt).getTime() : NaN;
    if (!Number.isFinite(next) || !Number.isFinite(updated)) return false;
    const leaseMs = leaseMinutes * 60_000;
    // An hour is the longest retry backoff; anything shorter is not a lease.
    if (leaseMs <= HOURLY_MS) return false;
    const renewMs = Math.max(60_000, Math.floor(leaseMs / 3));
    return next - updated >= leaseMs - 60_000 && Date.now() - updated < renewMs + 60_000 && next > Date.now();
}

/**
 * Record a lookup failure (the provider calls before the ingest) on the job
 * and throw. A classified terminal code freezes the job; anything else
 * retries with backoff — but not forever: once the meeting is older than
 * `deadlineMs` the job freezes as 'failed' with the last error, instead of
 * being re-claimed every hour for good with no error to show for it.
 *
 * @param {{
 *   store: { failJob: (id: string, opts: any) => Promise<any> },
 *   job: any, err: any, terminalCodes: Set<string>, deadlineMs: number, fallbackMessage: string,
 * }} opts
 * @returns {Promise<never>}
 */
async function failLookup({ store, job, err, terminalCodes, deadlineMs, fallbackMessage }) {
    const code = err?.code || null;
    const message = String(err?.message || err || fallbackMessage).slice(0, 500);
    if (code && terminalCodes.has(code)) {
        await store.failJob(job.id, { errorCode: code, terminal: true, lastError: message });
        throw err;
    }
    if (Date.now() > meetingEndMs(job) + deadlineMs) {
        await store.failJob(job.id, { errorCode: 'failed', terminal: true, lastError: `lookup kept failing: ${message}` });
        throw codedError(err?.message || fallbackMessage, 'failed');
    }
    await store.failJob(job.id, {
        errorCode: null, lastError: message,
        terminal: false, status: job.status, backoffMs: backoffMsFor(job.attempts),
    });
    throw codedError(err?.message || fallbackMessage, 'failed');
}

module.exports = {
    codedError,
    backoffMsFor,
    meetingEndMs,
    ingestAttempt,
    resolveOrgIdForUser,
    listCandidateUsers,
    makeDiscovery,
    failIngest,
    failLookup,
    processDueJobs,
    withLeaseHeartbeat,
    isIngestInFlight,
};
