// @typecheck
/**
 * The run's marker, lifecycle events and heartbeat (moved verbatim out of
 * execution.js's executeAutomation).
 *
 * acquireRunMarker / claimRunMarker decide whether a live run owns the
 * automation-level running marker (waiting for it, running alongside it, or
 * skipping the run); makeLifecycleEmitter builds the run's SSE emitter; and
 * startHeartbeat keeps the run row and the marker fresh while the run lives.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const runEventBus = require('../runEventBus');
const log = require('../../telemetry/log');
const { writeRunOutcome, withLastOutput } = require('./runFinalize');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * A live run that finds its automation ALREADY RUNNING.
 *
 * The automation-level marker (`automations.last_status = 'running'`) allows one
 * live run at a time, and a second one used to be cancelled on the spot —
 * "Skipped: automation already running". For a manual click that is the right
 * answer. For an EVENT it is data loss: the Gmail poller has already advanced
 * its cursor, so the mail that arrived while a briefing was running is never
 * triaged. With several triggers on one automation those collisions stop being
 * rare, so event- and webhook-started runs now WAIT for the marker — bounded,
 * polling — and only give up (cancelled, as before) when the window passes.
 *
 * Resumes never wait: a resume continues alongside whatever holds the marker
 * (see the guard in executeAutomation).
 */
const CONCURRENT_WAIT_MS = Math.max(0, Number(process.env.AUTOMATION_CONCURRENT_WAIT_MS ?? 300_000) || 0);
const CONCURRENT_POLL_MS = Math.max(50, Number(process.env.AUTOMATION_CONCURRENT_POLL_MS) || 5_000);
const WAITS_FOR_MARKER = new Set(['app_event', 'webhook']);
const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
});

async function acquireRunMarker(deps, automationId, triggerKind, { wait = true } = {}) {
    const { automationStore } = deps;
    const { INSTANCE_ID } = deps.engine;
    // Fail OPEN on an infra error (catch→true); only the explicit `false`
    // "already running" contract blocks a concurrent run.
    const attempt = () => automationStore.markRunning(automationId, INSTANCE_ID).catch(() => true);
    let acquired = await attempt();
    if (acquired !== false || !wait || !WAITS_FOR_MARKER.has(triggerKind) || CONCURRENT_WAIT_MS <= 0) return acquired;
    log.info(`[AutomationRunner] ${automationId} already running — ${triggerKind} run waits up to ${Math.round(CONCURRENT_WAIT_MS / 1000)}s for it to finish`);
    const deadline = Date.now() + CONCURRENT_WAIT_MS;
    while (Date.now() < deadline) {
        await sleep(Math.min(CONCURRENT_POLL_MS, Math.max(1, deadline - Date.now())));
        acquired = await attempt();
        if (acquired !== false) return acquired;
    }
    return false;
}

/** The run's lifecycle emitter (a no-op for dry runs). */
function makeLifecycleEmitter({ run, automation, effectiveMode }) {
    // Live run-lifecycle events for the executions UI's SSE stream. Skipped for
    // dry-runs (the executions table only shows live runs) and never allowed to
    // throw — emission must not break a run. Stamped with userId so the stream
    // route can scope events per-user, + automationId so a single-surface view
    // can filter. Attached to ctx so runDag can emit step.* with the same shape.
    // A run on its starter's own connections streams no data: the stream goes
    // to the owner, and the run's values belong to the starter.
    const hideData = run.connectionsMode === 'caller';
    const DATA_KEYS = ['error', 'output', 'input', 'summary'];
    const emitLifecycle = (type, rawExtra = {}) => {
        if (effectiveMode === 'dry_run') return;
        const extra = hideData ? Object.fromEntries(Object.entries(rawExtra).filter(([k]) => !DATA_KEYS.includes(k))) : rawExtra;
        try {
            runEventBus.emitRunEvent(type, {
                runId: run.id, automationId: automation.id, userId: automation.userId,
                // The JOURNEY this event belongs to. A run that continues a
                // paused one is a row the history does not list — it folds into
                // its head — so an event addressed only by runId would update
                // nothing, and the visible row would sit on "Still running…"
                // until a manual refresh.
                rootRunId: run.rootRunId || run.id,
                ...extra,
            });
        } catch (err) { bestEffort('core/automationRunner/runHeartbeat:emitLifecycle', err); /* never break a run on telemetry */ }
    };
    return emitLifecycle;
}

/**
 * Take the automation's running marker for a live run, or decide not to.
 *
 * @returns {Promise<{ ownsMarker: boolean, skipped: boolean, row: object|null }>}
 *   `skipped` with the cancelled run row (lastOutput attached) when the run
 *   was dropped because the automation was already running.
 */
async function claimRunMarker(deps, { automation, run, runPolicy, triggerKind, effectiveMode, isResume, startedAt, emitLifecycle }) {
    const { automationStore, clearRunCancellation } = deps;
    // §WS2.4 — concurrency guard. markRunning atomically flips the automations
    // row to 'running' and RETURNS FALSE if a run is already in flight. We honour
    // that so two overlapping manual/webhook/event triggers don't execute the
    // same automation twice (duplicate side effects), and so a finishing sibling
    // can't clear the running marker out from under an active run (which would
    // defeat the reaper's crash recovery). Schedule runs are already claimed
    // atomically by claimDueAutomations(), and dry-runs are previews that must
    // never touch the marker — so only LIVE non-schedule runs mark/own it here.
    // `ownsMarker` then gates releaseAutomation in the finally so a dry-run can't
    // release a concurrent live run's marker.
    //
    // A RESUME is not a new trigger. resumeFromStep re-enters here with the
    // ORIGINAL run's triggerKind, so an approval decision or a form submission
    // was indistinguishable from a fresh webhook — and if any other live run of
    // the same automation happened to hold the marker at that moment, the approved
    // continuation was finalised as 'cancelled' having dispatched nothing. The
    // approve endpoint has already consumed the single-use token and stamped
    // the parent 'success' by then, and no endpoint can re-issue it, so the
    // approved work was simply lost. The run being resumed was accounted for
    // when it was triggered, and its marker was released when it PAUSED, so
    // there is nothing left to deduplicate: continue, but WITHOUT claiming
    // ownership of a marker another run holds (releasing it in the finally
    // would clear it out from under that run — the very hazard the guard
    // exists to prevent).
    // runPolicy.concurrency 'parallel' (handoff 5): a live run that finds the
    // automation busy runs ALONGSIDE it, exactly the way a resume does — it
    // takes the marker when it is free and never waits for it, and when it is
    // not free it runs without owning it (so it cannot release it from under
    // the run that does). 'serial' (the default) is today's behaviour.
    const parallel = runPolicy.concurrency === 'parallel';
    let ownsMarker = effectiveMode === 'live';
    if (triggerKind !== 'schedule' && effectiveMode === 'live') {
        // Event/webhook runs wait (bounded) for a busy automation instead of
        // being dropped — see acquireRunMarker. A resume never waits.
        const acquired = await acquireRunMarker(deps, automation.id, triggerKind, { wait: !isResume && !parallel });
        if (acquired === false && (isResume || parallel)) {
            log.warn(`[AutomationRunner] ${automation.id} already running — ${isResume ? `resuming run ${run.id} alongside it (a resume is a continuation, not a new trigger)` : `running ${run.id} alongside it (concurrency: parallel)`}`);
            ownsMarker = false;
        } else if (acquired === false) {
            log.warn(`[AutomationRunner] ${automation.id} already running — skipping concurrent ${triggerKind} run ${run.id}`);
            const finishedAt = new Date().toISOString();
            await automationStore.updateRun(run.id, {
                status: 'cancelled', finishedAt, durationMs: Date.now() - startedAt,
                error: 'Skipped: automation already running',
                summary: 'Skipped — this automation was already running.',
            }).catch((e) => bestEffort('core/automationRunner/runHeartbeat:claimRunMarker', e));
            await writeRunOutcome(deps, { runId: run.id, status: 'cancelled', cancelReason: 'already_running' });
            clearRunCancellation(run.id);
            emitLifecycle('run.started', { triggerKind, mode: effectiveMode, title: automation.title || null, kind: automation.kind || 'automation', version: automation.version });
            emitLifecycle('run.finished', { status: 'cancelled', durationMs: Date.now() - startedAt });
            return { ownsMarker, skipped: true, row: withLastOutput(await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'cancelled' })), null) };
        }
    }
    return { ownsMarker, skipped: false, row: null };
}

/** The marker refresh the heartbeat and a deadline extension call. */
function makeRunMarkerToucher(deps, { ownsMarker, automation }) {
    const { automationStore } = deps;
    const { INSTANCE_ID } = deps.engine;
    // Keep the AUTOMATIONS-row running marker fresh (A8 / W5-16).
    //
    // The run row has a heartbeat; the automations row had only
    // `running_started_at`, stamped once at claim time, and reapStuckAutomations
    // resets any row older than max(REAPER_FLOOR_MS, run_timeout_ms +
    // REAPER_BUFFER_MS) — at most ~61 minutes. A Wait step, meanwhile, extends
    // only the IN-PROCESS deadline (ctx.extendRunDeadline) and can legitimately
    // sleep for up to 24 hours. So a long wait had the row reaped out from
    // under a perfectly healthy run: the concurrency marker went away, and the
    // scheduler started a SECOND run of the same automation while the first was
    // still sleeping. Refreshing the marker from the same heartbeat that keeps
    // the run row alive makes both clocks derive from one fact — this runner
    // process is still here — instead of from two unrelated numbers. A crashed
    // pod stops heartbeating and is still reaped exactly as before.
    const touchRunMarker = () => {
        if (!ownsMarker) return;
        // Capability-checked: a store build without the marker touch keeps the
        // old behaviour rather than throwing on every heartbeat tick.
        try { automationStore.touchAutomationRunning?.(automation.id, INSTANCE_ID)?.catch?.((e) => bestEffort('core/automationRunner/runHeartbeat:touchRunMarker', e)); }
        catch (err) { bestEffort('core/automationRunner/runHeartbeat:touchRunMarker#2', err); /* the marker refresh must never break a run */ }
    };
    return touchRunMarker;
}

/** The run's 15-second heartbeat timer, or null for a dry run. */
function startHeartbeat(deps, { effectiveMode, emitLifecycle, run, touchRunMarker }) {
    const { automationStore } = deps;
    // Heartbeat (live runs only): keeps the SSE stream warm AND stamps
    // last_heartbeat_at so the stuck-run reaper sees the run as alive.
    const heartbeatTimer = (effectiveMode === 'dry_run') ? null : setInterval(() => {
        emitLifecycle('step.heartbeat', { at: new Date().toISOString() });
        automationStore.touchRunHeartbeat(run.id).catch((e) => bestEffort('core/automationRunner/runHeartbeat:startHeartbeat', e));
        touchRunMarker();
    }, 15_000);
    if (heartbeatTimer?.unref) heartbeatTimer.unref();
    return heartbeatTimer;
}

module.exports = { acquireRunMarker, makeLifecycleEmitter, claimRunMarker, makeRunMarkerToucher, startHeartbeat };
