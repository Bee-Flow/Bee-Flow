/**
 * The runner's periodic ticks and the boot/drain lifecycle that mounts them
 * (extracted verbatim from automationRunner.js).
 *
 *   - 60s: schedule trigger pickup (next_run_at <= NOW()), Talk auto-record.
 *   - 30s: app-event subscription renewal + polling.
 *   - 120s: Google Meet auto-import discovery + ingest.
 *   - hourly: run-history retention and the reapers that ride that tick.
 *
 * start() mounts them all; stop() drains for SIGTERM and isStopping() is what
 * keeps a tick racing the drain from claiming new work.
 */

const automationStore = require('../../../stores/automationStore');
const { pool } = require('../../../db');
const holidays = require('../../../automation/holidays');
const { holidaySkipFor } = require('./holidaySkip');
const { ACTIVE_RUNS } = require('../cancellation');
const {
    RUNNER_INTERVAL_MS, POLLING_INTERVAL_MS, REAPER_INTERVAL_MS, RETENTION_INTERVAL_MS,
    MAX_CONCURRENT,
} = require('../shared');
// Stable per-process token identifying which runner instance claimed a row.
const { INSTANCE_ID } = require('../engine');
const { executeAutomation } = require('../execution');
const {
    reapStuckAutomations,
    reapOrphanFormUploads,
    reapExpiredGeneratedFiles,
    reapStuckTranscriptions,
} = require('./reapers');
const log = require('../../../telemetry/log');

// ── Schedule tick ───────────────────────────────────────

/** Does this claimed row's LIVE schedule (primary, or one extra trigger) skip holidays? */
function skipsHolidays(a, triggerStepId) {
    const { definition } = require('../definitionForRun').definitionForRun(a, { mode: 'live', triggerKind: 'schedule' });
    return holidays.scheduleSkipsHolidays(definition, triggerStepId);
}

/**
 * ADDITIONAL schedule triggers (`automation_schedules`, 2026-09). Runs inside
 * the same 60s tick as the primary pass — NOT as a ninth interval, so the boot
 * kickoff/interval accounting stays what ticks.test.js pins — and dispatches
 * each claimed row from its OWN trigger node (`rootStepId`) with the schedule
 * in hand, so the runner advances that row rather than the primary's columns.
 * Capability-checked: an older store build without the aggregate just skips.
 */
async function processDueSchedules() {
    if (stopping) return;
    if (typeof automationStore.claimDueSchedules !== 'function') return;
    let due;
    try { due = await automationStore.claimDueSchedules(INSTANCE_ID, 20); }
    catch (e) { log.error('[AutomationRunner] processDueSchedules claim error:', e.message); return; }
    if (!due || due.length === 0) return;

    const { hasCapability } = require('../../entitlements/entitlements');
    const allowed = [];
    for (const { automation: a, schedule: s } of due) {
        let ok = false;
        try { ok = await hasCapability('automations', { userId: a.userId, orgId: a.organizationId }); }
        catch (_) { ok = false; }
        if (ok) {
            // schedule.skipHolidays: a slot on a public holiday is not run;
            // the schedule moves on to its next working slot.
            const skip = holidaySkipFor(a, { triggerStepId: s.triggerStepId, cron: s.cron, tz: s.tz, scheduledFor: s.nextRunAt });
            if (!skip) { allowed.push({ a, s }); continue; }
            log.info(`[AutomationRunner] Skipping ${a.id} (schedule ${s.triggerStepId}) on ${skip.holiday.date} (${skip.holiday.key}): the schedule skips public holidays`);
            await automationStore.releaseAutomation(a.id).catch(() => {});
            await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch(() => {});
            await automationStore.advanceSchedule(s.id, { nextRunAt: skip.nextRunAt, lastStatus: 'skipped' }).catch(() => {});
            continue;
        }
        // Same release-and-advance as the primary pass: a row left in the past
        // would re-qualify every tick and starve other due work.
        log.info(`[AutomationRunner] Skipping ${a.id} (schedule ${s.triggerStepId}) — owner ${a.userId} no longer has automations`);
        await automationStore.releaseAutomation(a.id).catch(() => {});
        await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch(() => {});
        let nextRunAt = null;
        try { nextRunAt = holidays.nextScheduledRunAt(s.cron, s.tz, Date.now(), { skipHolidays: skipsHolidays(a, s.triggerStepId) }); } catch (_) { nextRunAt = null; }
        await automationStore.advanceSchedule(s.id, { nextRunAt, lastStatus: 'skipped' }).catch(() => {});
    }
    for (let i = 0; i < allowed.length; i += MAX_CONCURRENT) {
        const batch = allowed.slice(i, i + MAX_CONCURRENT);
        const now = new Date().toISOString();
        await Promise.allSettled(batch.map(({ a, s }) => executeAutomation(a, {
            triggerKind: 'schedule',
            rootStepId: s.triggerStepId,
            triggerPayload: { now },
            schedule: { id: s.id, cron: s.cron, tz: s.tz, scheduledFor: s.nextRunAt },
        })));
    }
}

async function processDueAutomations() {
    // Don't claim new scheduled work once a drain has begun — a tick racing
    // the SIGTERM would start a run we're about to abandon.
    if (stopping) return;
    await processDuePrimarySchedules();
    await processDueSchedules().catch(e => log.error('[AutomationRunner] processDueSchedules error:', e.message));
    // Routine-evolution canaries: judge the ones that have seen enough runs.
    // Lazy-required and fully caught so a store hiccup never touches scheduling.
    try {
        await require('../../../automation/evolution').evaluateCanaries();
    } catch (e) {
        log.error('[AutomationRunner] evaluateCanaries error:', e.message);
    }
}

async function processDuePrimarySchedules() {
    try {
        // Atomic claim with `FOR UPDATE SKIP LOCKED`: each row is owned by
        // exactly one runner instance, even when multiple workers share a
        // DB. Replaces the old read-then-mark pattern that allowed double
        // execution if a runner crashed between read and mark.
        const due = await automationStore.claimDueAutomations(INSTANCE_ID, 20);
        if (due.length === 0) return;

        // Filter by per-org beta access. If an org loses the 'automations'
        // beta, their automations stop firing on schedule (but stay in the
        // DB so re-enabling restores them instantly). Skipped rows are
        // released so the schedule advances on the next tick.
        const { hasCapability } = require('../../entitlements/entitlements');
        const allowed = [];
        for (const a of due) {
            try {
                // Resolve against the automation's OWN org (not the owner's
                // primary org) via the unified resolver, so scheduled firing
                // agrees with the requireCapability('automations') route gate.
                const ok = await hasCapability('automations', { userId: a.userId, orgId: a.organizationId });
                const skip = ok && a.triggerType === 'schedule' && a.scheduleCron
                    ? holidaySkipFor(a, { cron: a.scheduleCron, tz: a.scheduleTz, scheduledFor: a.nextRunAt })
                    : null;
                if (ok && skip) {
                    // schedule.skipHolidays: a slot on a public holiday is not
                    // run. Release and advance, exactly like the entitlement
                    // skip below, so the row cannot re-qualify every tick.
                    log.info(`[AutomationRunner] Skipping ${a.id} on ${skip.holiday.date} (${skip.holiday.key}): the schedule skips public holidays`);
                    await automationStore.releaseAutomation(a.id);
                    await automationStore.updateAutomation(a.id, { lastStatus: 'pending', nextRunAt: skip.nextRunAt }, a.userId).catch(() => {});
                } else if (ok) allowed.push(a);
                else {
                    log.info(`[AutomationRunner] Skipping ${a.id} — owner ${a.userId} no longer has automations beta`);
                    await automationStore.releaseAutomation(a.id);
                    // Advance next_run_at to the NEXT scheduled time — not just
                    // release. Leaving next_run_at in the past means the row
                    // re-qualifies for claimDueAutomations every tick, burning
                    // a claim slot (batch of 20) and starving other orgs' due
                    // automations behind it until the beta is restored.
                    let nextRunAt = null;
                    if (a.triggerType === 'schedule' && a.scheduleCron) {
                        try { nextRunAt = holidays.nextScheduledRunAt(a.scheduleCron, a.scheduleTz, Date.now(), { skipHolidays: skipsHolidays(a, null) }); } catch (_) { nextRunAt = null; }
                    }
                    await automationStore.updateAutomation(a.id, { lastStatus: 'pending', nextRunAt }, a.userId).catch(() => {});
                }
            } catch (_) {
                // On lookup failure, release rather than fire incorrectly —
                // and move last_status OFF 'running' in the same breath.
                // markRunning gates on last_status, so releasing the marker
                // alone leaves the row refusing every future run, with
                // running_started_at NULL so the reaper's stale-marker clause
                // could never find it either. Silent, permanent, and only
                // fixable by hand.
                await automationStore.releaseAutomation(a.id).catch(() => {});
                await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch(() => {});
            }
        }
        if (allowed.length === 0) return;

        for (let i = 0; i < allowed.length; i += MAX_CONCURRENT) {
            const batch = allowed.slice(i, i + MAX_CONCURRENT);
            // `{ now }` is the one field the builder catalog advertises for a
            // schedule trigger (`__schedule.now`); it used to be a promise the
            // runtime never kept, so `trigger.output.now` resolved undefined.
            const now = new Date().toISOString();
            await Promise.allSettled(batch.map(a => executeAutomation(a, { triggerKind: 'schedule', triggerPayload: { now } })));
        }
    } catch (e) {
        log.error('[AutomationRunner] processDueAutomations error:', e.message);
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
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [POLLING_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) {
            // Another pod owns the lock for this tick; back off cleanly.
            return;
        }
        const triggerBus = require('../../../automation/triggerBus');
        await triggerBus.runPollingPass();
        await triggerBus.renewExpiringSubscriptions();
    } catch (e) {
        log.error('[AutomationRunner] polling/renewal error:', e.message);
    } finally {
        if (client) {
            try {
                if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [POLLING_LOCK_KEY]);
            } catch (_) { /* lock release is best-effort */ }
            client.release();
        }
    }
}

// Talk auto-record: poll active Talk calls of opted-in users and start
// recording the ones they moderate. Single-pod-per-tick via its own advisory
// lock (same discipline as polling — a different stable key).
const TALK_AUTORECORD_LOCK_KEY = 0xBEEF106;

async function processTalkAutoRecord() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [TALK_AUTORECORD_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('../../meetingNotes/talkAutoRecord').scanAndRecord();
    } catch (e) {
        log.error('[AutomationRunner] talk auto-record error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [TALK_AUTORECORD_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

// Google Meet auto-import: discovery (calendar scan → seed gmeet_import_jobs)
// is metadata-only and runs under its own advisory lock so one pod scans per
// tick; the ingest worker claims jobs via FOR UPDATE SKIP LOCKED, so it runs
// AFTER the lock is released and on every pod.
const GMEET_IMPORT_LOCK_KEY = 0xBEEF10A;

async function processGmeetAutoImport() {
    const gmeetAutoImport = require('../../meetingNotes/gmeetAutoImport');
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [GMEET_IMPORT_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (acquired) await gmeetAutoImport.discover();
    } catch (e) {
        log.error('[AutomationRunner] gmeet auto-import discovery error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [GMEET_IMPORT_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
    try {
        await gmeetAutoImport.processDue();
    } catch (e) {
        log.error('[AutomationRunner] gmeet auto-import ingest error:', e.message);
    }
}

// §WS3.1 — run-history retention sweep. Advisory-locked so only one pod drains
// the backlog per tick (the DELETE is safe concurrently, but one pod is enough).
const RETENTION_LOCK_KEY = 0xBEEF107;

async function processRunRetention() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [RETENTION_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('../../../jobs/runRetention').runRetentionPass();
        // Routines in the trash past their 30 days (handoff 5). Same shape of
        // work as the pass above — bounded, idempotent, one pod — so it
        // shares this tick and its lock. Never lets a failure end the tick.
        try {
            await require('../../../jobs/automationTrashPurge').purgeTrashPass();
        } catch (e) {
            log.warn('[AutomationRunner] trash purge failed:', e.message);
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
        // Visitor sessions for multi-page forms. Purely a pointer row, so this
        // is a plain delete — the run it referenced has its own retention.
        try {
            const n = await require('../../../stores/automationStore').deleteExpiredFormSessions(500);
            if (n) log.info(`[AutomationRunner] reaped ${n} expired form session(s)`);
        } catch (e) {
            log.warn('[AutomationRunner] form-session reap failed:', e.message);
        }
    } catch (e) {
        log.error('[AutomationRunner] run-retention error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
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
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DATATABLE_RETENTION_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('../../../jobs/datatableRetention').datatableRetentionPass();
    } catch (e) {
        log.error('[AutomationRunner] datatable-retention error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [DATATABLE_RETENTION_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

// Routine notifications that wait: throttled messages bundled into one
// "n more", and the daily summary (jobs/automationDigest.js, handoff 5).
// Five minutes keeps a 17:00 summary within minutes of 17:00. One pod.
const NOTIFICATION_DIGEST_LOCK_KEY = 0xBEEF112;
const NOTIFICATION_DIGEST_INTERVAL_MS = 5 * 60_000;

async function processNotificationDigest() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [NOTIFICATION_DIGEST_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('../../../jobs/automationDigest').digestPass();
    } catch (e) {
        log.error('[AutomationRunner] notification digest error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [NOTIFICATION_DIGEST_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

// ── Boot ────────────────────────────────────────────────

let started = false;
let stopping = false;
const _tickHandles = [];

/**
 * setInterval + an async function is a pile-up waiting for a slow dependency:
 * the timer does not wait for the previous invocation, so if one tick outlasts
 * its period the next starts on top of it, and so on, without bound.
 *
 * That stopped being theoretical when the approval sweep gained an outbound
 * leg: reapStuckAutomations now polls Nextcloud for Talk reactions, up to 200
 * cards sequentially (automation/approvalReactionIngest.js). Against a slow or
 * unreachable Nextcloud one 60-second tick can run for an hour, and a fresh one
 * would have started every minute behind it — each holding its own DB client
 * and its own socket queue.
 *
 * Skipping is the right answer for every tick here: they are all reapers,
 * pollers and sweeps that re-read their work from the database, so a skipped
 * tick loses nothing — the next one picks the same rows up.
 */
// Runtime module gate. The boot-time checks in boot/startupTasks.js read the
// deploy-time catalog flag and decide whether to START these ticks at all;
// this one re-checks the runtime row every tick, so removing Automations or
// Meeting Notes from the admin Modules panel actually stops the work instead
// of only hiding its routes. TTL-cached, and fails open.
const { moduleGatedTick } = require('../../../modules');

function nonOverlapping(fn, name) {
    let inFlight = false;
    let skipped = 0;
    return async function guardedTick(...args) {
        if (inFlight) {
            skipped += 1;
            // Log on the powers of two so a persistent stall is visible without
            // a slow dependency also becoming a log flood.
            if ((skipped & (skipped - 1)) === 0) {
                log.warn(`[AutomationRunner] ${name} still running — skipped ${skipped} tick(s)`);
            }
            return undefined;
        }
        inFlight = true;
        skipped = 0;
        try {
            return await fn(...args);
        } finally {
            inFlight = false;
        }
    };
}

async function start() {
    if (started) return;
    // Three gates, three lifetimes — don't confuse them. boot/startupTasks.js
    // decides whether we mount anything at all from the DEPLOY-TIME catalog
    // flag (isModuleAvailable), read once at boot and never again.
    // moduleGatedTick re-reads the RUNTIME module row on every invocation, so
    // an admin switching Automations off in the Modules panel stops the work
    // on a pod that is already running. Per-org gating is a third thing again,
    // enforced inside processDueAutomations() via the 'automations' beta —
    // orgs without it have their due rows skipped and released each tick.
    //
    // Each tick is wrapped ONCE, into a local, and that same reference is what
    // both the interval and the boot kickoff below get. Wrapping a second time
    // for the kickoff would be worse than useless: nonOverlapping() closes over
    // its own `inFlight` flag, so a separately-wrapped kickoff would happily
    // run on top of the interval it is supposed to be serialised with.
    started = true;
    const dueTick = nonOverlapping(moduleGatedTick('automation', processDueAutomations, 'processDueAutomations'), 'processDueAutomations');
    const pollingTick = nonOverlapping(moduleGatedTick('automation', processPollingAndRenewals, 'processPollingAndRenewals'), 'processPollingAndRenewals');
    const reapTick = nonOverlapping(moduleGatedTick('automation', reapStuckAutomations, 'reapStuckAutomations'), 'reapStuckAutomations');
    const talkTick = nonOverlapping(moduleGatedTick('meetingNotes', processTalkAutoRecord, 'processTalkAutoRecord'), 'processTalkAutoRecord');
    const gmeetTick = nonOverlapping(moduleGatedTick('meetingNotes', processGmeetAutoImport, 'processGmeetAutoImport'), 'processGmeetAutoImport');
    const retentionTick = nonOverlapping(moduleGatedTick('automation', processRunRetention, 'processRunRetention'), 'processRunRetention');
    const transcriptionTick = nonOverlapping(moduleGatedTick('meetingNotes', reapStuckTranscriptions, 'reapStuckTranscriptions'), 'reapStuckTranscriptions');
    const datatableRetentionTick = nonOverlapping(processDatatableRetention, 'processDatatableRetention');
    const digestTick = nonOverlapping(moduleGatedTick('automation', processNotificationDigest, 'processNotificationDigest'), 'processNotificationDigest');
    _tickHandles.push(setInterval(dueTick, RUNNER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(pollingTick, POLLING_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(reapTick, REAPER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(talkTick, RUNNER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(gmeetTick, 120_000).unref());
    // §WS3.1 — run-history retention. Hourly is plenty (it batch-drains a
    // platform-wide age window); the job no-ops when retention is disabled.
    _tickHandles.push(setInterval(retentionTick, RETENTION_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(transcriptionTick, 15 * 60_000).unref());
    _tickHandles.push(setInterval(datatableRetentionTick, RETENTION_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(digestTick, NOTIFICATION_DIGEST_INTERVAL_MS).unref());
    // Boot kickoffs. The first interval fire is a whole period away, and for
    // retention that period is an HOUR — longer than plenty of pods live, so
    // this timeout is the only retention pass a short-lived replica ever runs.
    // They deliberately reuse the wrappers above rather than calling the raw
    // functions: an ungated burst here is exactly the bug that let a pod whose
    // Automations module was switched OFF still execute due automations once
    // per restart and — worse — run the retention pass, which DELETEs for
    // real (run history, orphan form uploads, expired generated files,
    // expired form sessions).
    //
    // Their handles go into _tickHandles too, so a SIGTERM inside the first
    // minute cancels the pending sweep instead of racing it. stop() needs no
    // special case for them: Node's clearInterval IS clearTimeout.
    for (const [fn, delay] of [[dueTick, 10_000], [reapTick, 15_000], [retentionTick, 60_000], [datatableRetentionTick, 90_000]]) {
        const t = setTimeout(fn, delay);
        t.unref?.();
        _tickHandles.push(t);
    }
    log.info(`[AutomationRunner] started (instance=${INSTANCE_ID}, 60s schedule, 30s polling, 60s reaper, 60s talk-autorecord, 120s gmeet-import, ${Math.round(RETENTION_INTERVAL_MS / 60000)}m retention)`);
}

/**
 * Graceful drain for shutdown (SIGTERM/SIGINT). Stops the schedule/poll ticks
 * so no NEW runs are claimed, then waits (bounded) for in-flight runs to
 * finish. Without this, a deploy kills mid-run executions: the run row stays
 * 'running' (later reaped) and — worse — a side-effecting step that already
 * fired may run AGAIN when the row is re-claimed after restart. Returns the
 * number of runs still in flight when the timeout elapsed (0 = clean drain).
 */
async function stop({ timeoutMs = 25_000 } = {}) {
    if (stopping) return ACTIVE_RUNS.size;
    stopping = true;
    for (const h of _tickHandles) { try { clearInterval(h); } catch (_) { /* noop */ } }
    _tickHandles.length = 0;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (ACTIVE_RUNS.size > 0 && Date.now() < deadline) {
        log.info(`[AutomationRunner] draining — ${ACTIVE_RUNS.size} run(s) still in flight…`);
        await new Promise(r => setTimeout(r, 500));
    }
    if (ACTIVE_RUNS.size > 0) {
        log.warn(`[AutomationRunner] drain timeout — ${ACTIVE_RUNS.size} run(s) still running; the stale-run reaper will recover them.`);
    } else {
        log.info('[AutomationRunner] drained cleanly (no in-flight runs).');
    }
    // Egress rows are written detached (core/integrationLogging.js) so a step
    // never waits on monitoring — flush the stragglers before the process goes.
    try {
        await require('../../integrations/integrationLogging').flushEgressLogs();
    } catch (_) { /* best-effort */ }
    started = false;
    return ACTIVE_RUNS.size;
}

// New runs must not start once a drain has begun — otherwise a poll/dispatch
// racing the SIGTERM could claim work we're trying to wind down.
function isStopping() { return stopping; }

module.exports = { start, stop, isStopping, processDueAutomations };
