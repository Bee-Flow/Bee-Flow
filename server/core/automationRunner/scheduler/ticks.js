// @typecheck
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
const holidays = require('../../scheduling/holidays');
const { holidaySkipFor } = require('./holidaySkip');
// What the ticks drive in automation/ and jobs/ (both above core) and in
// meeting notes (core/meetingNotes/runnerPorts.js): see ../featurePorts.js.
const { runnerPort } = require('../featurePorts');
// Google Meet auto-import: discovery under a NAMED lock (one pod per tick),
// then the ingest worker on every pod.
const { processGmeetAutoImport } = require('./gmeetImportTick');
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
    reapStuckTranscriptions,
} = require('./reapers');
const log = require('../../../telemetry/log');

// ── Schedule tick ───────────────────────────────────────

/**
 * May this owner's schedules still fire? Only for an account that exists and
 * is plainly active (auth/accountStatusGate.isActiveAccount, the rule a
 * bearer credential is held to): a routine keeps acting with its owner's
 * standing, so a suspended or removed owner's routines stop with them. Then
 * the organisation's entitlement, as before. A lookup failure is a refusal.
 * `seen` keeps one log line per owner per tick.
 * @param {{ userId: string, organizationId?: string | null }} a
 * @param {Set<string>} seen
 */
async function ownerMayRun(a, seen) {
    const { isActiveAccount } = require('../../../auth/accountStatusGate');
    const { hasCapability } = require('../../entitlements/entitlements');
    const owner = await require('../../../stores/userStore').getUser(a.userId);
    if (!isActiveAccount(owner)) {
        if (!seen.has(a.userId)) {
            seen.add(a.userId);
            log.info(`[AutomationRunner] Schedules of owner ${a.userId} do not run: the account is ${owner ? owner.status : 'gone'}`);
        }
        return false;
    }
    return hasCapability('automations', { userId: a.userId, orgId: a.organizationId });
}

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

    const allowed = [];
    const seen = new Set();
    for (const { automation: a, schedule: s } of due) {
        let ok = false;
        try { ok = await ownerMayRun(a, seen); }
        catch (_) { ok = false; }
        if (ok) {
            // schedule.skipHolidays: a slot on a public holiday is not run;
            // the schedule moves on to its next working slot.
            const skip = holidaySkipFor(a, { triggerStepId: s.triggerStepId, cron: s.cron, tz: s.tz, scheduledFor: s.nextRunAt });
            if (!skip) { allowed.push({ a, s }); continue; }
            log.info(`[AutomationRunner] Skipping ${a.id} (schedule ${s.triggerStepId}) on ${skip.holiday.date} (${skip.holiday.key}): the schedule skips public holidays`);
            await automationStore.releaseAutomation(a.id).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules', e));
            await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules#2', e));
            await automationStore.advanceSchedule(s.id, { nextRunAt: skip.nextRunAt, lastStatus: 'skipped' }).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules#3', e));
            continue;
        }
        // Same release-and-advance as the primary pass: a row left in the past
        // would re-qualify every tick and starve other due work.
        log.info(`[AutomationRunner] Skipping ${a.id} (schedule ${s.triggerStepId}) — owner ${a.userId} no longer has automations`);
        await automationStore.releaseAutomation(a.id).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules#4', e));
        await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules#5', e));
        let nextRunAt = null;
        try { nextRunAt = holidays.nextScheduledRunAt(s.cron, s.tz, Date.now(), { skipHolidays: skipsHolidays(a, s.triggerStepId) }); } catch (_) { nextRunAt = null; }
        await automationStore.advanceSchedule(s.id, { nextRunAt, lastStatus: 'skipped' }).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDueSchedules#6', e));
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
    // Automation-evolution canaries: judge the ones that have seen enough runs.
    // Lazy-required and fully caught so a store hiccup never touches scheduling.
    try {
        await runnerPort('evolution').evaluateCanaries();
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

        // Filter by the owner's standing and per-org beta access. If an org
        // loses the 'automations' beta, their automations stop firing on
        // schedule (but stay in the DB so re-enabling restores them
        // instantly); the same for an owner whose account is not active.
        // Skipped rows are released so the schedule advances on the next
        // tick.
        const allowed = [];
        const seen = new Set();
        for (const a of due) {
            try {
                // Resolve against the automation's OWN org (not the owner's
                // primary org) via the unified resolver, so scheduled firing
                // agrees with the requireCapability('automations') route gate.
                const ok = await ownerMayRun(a, seen);
                const skip = ok && a.triggerType === 'schedule' && a.scheduleCron
                    ? holidaySkipFor(a, { cron: a.scheduleCron, tz: a.scheduleTz, scheduledFor: a.nextRunAt })
                    : null;
                if (ok && skip) {
                    // schedule.skipHolidays: a slot on a public holiday is not
                    // run. Release and advance, exactly like the entitlement
                    // skip below, so the row cannot re-qualify every tick.
                    log.info(`[AutomationRunner] Skipping ${a.id} on ${skip.holiday.date} (${skip.holiday.key}): the schedule skips public holidays`);
                    await automationStore.releaseAutomation(a.id);
                    await automationStore.updateAutomation(a.id, { lastStatus: 'pending', nextRunAt: skip.nextRunAt }, a.userId).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDuePrimarySchedules', e));
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
                    await automationStore.updateAutomation(a.id, { lastStatus: 'pending', nextRunAt }, a.userId).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDuePrimarySchedules#2', e));
                }
            } catch (_) {
                // On lookup failure, release rather than fire incorrectly —
                // and move last_status OFF 'running' in the same breath.
                // markRunning gates on last_status, so releasing the marker
                // alone leaves the row refusing every future run, with
                // running_started_at NULL so the reaper's stale-marker clause
                // could never find it either. Silent, permanent, and only
                // fixable by hand.
                await automationStore.releaseAutomation(a.id).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDuePrimarySchedules#3', e));
                await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch((e) => bestEffort('core/automationRunner/scheduler/ticks:processDuePrimarySchedules#4', e));
            }
        }
        if (allowed.length === 0) return;

        for (let i = 0; i < allowed.length; i += MAX_CONCURRENT) {
            const batch = allowed.slice(i, i + MAX_CONCURRENT);
            // `{ now }` is the one field the builder catalog advertises for a
            // schedule trigger (`__schedule.now`); without it the promise of
            // `trigger.output.now` is not kept and it resolves undefined.
            const now = new Date().toISOString();
            await Promise.allSettled(batch.map(a => executeAutomation(a, { triggerKind: 'schedule', triggerPayload: { now } })));
        }
    } catch (e) {
        log.error('[AutomationRunner] processDueAutomations error:', e.message);
    }
}

// The lock-guarded background passes the ticks mount.
const {
    processPollingAndRenewals,
    processTalkAutoRecord,
    processTeamsAutoImport,
    processRunRetention,
    processDatatableRetention,
    processQueuedFormWork,
    processNotificationDigest,
    NOTIFICATION_DIGEST_INTERVAL_MS,
} = require('./passes');

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
const { bestEffort } = require('../../../utils/bestEffort');

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
    const teamsTick = nonOverlapping(moduleGatedTick('meetingNotes', processTeamsAutoImport, 'processTeamsAutoImport'), 'processTeamsAutoImport');
    const retentionTick = nonOverlapping(moduleGatedTick('automation', processRunRetention, 'processRunRetention'), 'processRunRetention');
    const transcriptionTick = nonOverlapping(moduleGatedTick('meetingNotes', reapStuckTranscriptions, 'reapStuckTranscriptions'), 'reapStuckTranscriptions');
    const datatableRetentionTick = nonOverlapping(processDatatableRetention, 'processDatatableRetention');
    const digestTick = nonOverlapping(moduleGatedTick('automation', processNotificationDigest, 'processNotificationDigest'), 'processNotificationDigest');
    const formQueueTick = nonOverlapping(moduleGatedTick('automation', processQueuedFormWork, 'processQueuedFormWork'), 'processQueuedFormWork');
    _tickHandles.push(setInterval(dueTick, RUNNER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(pollingTick, POLLING_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(reapTick, REAPER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(talkTick, RUNNER_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(gmeetTick, 120_000).unref());
    _tickHandles.push(setInterval(teamsTick, 120_000).unref());
    // §WS3.1 — run-history retention. Hourly is plenty (it batch-drains a
    // platform-wide age window); the job no-ops when retention is disabled.
    _tickHandles.push(setInterval(retentionTick, RETENTION_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(transcriptionTick, 15 * 60_000).unref());
    _tickHandles.push(setInterval(datatableRetentionTick, RETENTION_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(digestTick, NOTIFICATION_DIGEST_INTERVAL_MS).unref());
    _tickHandles.push(setInterval(formQueueTick, REAPER_INTERVAL_MS).unref());
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
    for (const [fn, delay] of /** @type {Array<[() => any, number]>} */ ([[dueTick, 10_000], [reapTick, 15_000], [formQueueTick, 20_000], [retentionTick, 60_000], [datatableRetentionTick, 90_000]])) {
        const t = setTimeout(fn, delay);
        t.unref?.();
        _tickHandles.push(t);
    }
    log.info(`[AutomationRunner] started (instance=${INSTANCE_ID}, 60s schedule, 30s polling, 60s reaper, 60s talk-autorecord, 120s gmeet-import, 120s teams-import, ${Math.round(RETENTION_INTERVAL_MS / 60000)}m retention)`);
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
    for (const h of _tickHandles) { try { clearInterval(h); } catch (err) { bestEffort('core/automationRunner/scheduler/ticks:stop', err); /* noop */ } }
    _tickHandles.length = 0;
    // Form submissions still waiting in this pod's queue: start no more of
    // them, and hand them back so another pod runs them now rather than after
    // their lease lapses. The one already running is an ACTIVE_RUN below.
    try {
        await runnerPort('formQueue').stop();
    } catch (e) {
        log.warn('[AutomationRunner] form-queue hand-back failed:', e.message);
    }
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
    } catch (err) { bestEffort('core/automationRunner/scheduler/ticks:stop#2', err); /* best-effort */ }
    started = false;
    return ACTIVE_RUNS.size;
}

// New runs must not start once a drain has begun — otherwise a poll/dispatch
// racing the SIGTERM could claim work we're trying to wind down.
function isStopping() { return stopping; }

module.exports = { start, stop, isStopping, processDueAutomations, processGmeetAutoImport, processQueuedFormWork };
