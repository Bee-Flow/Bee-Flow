// @typecheck
/**
 * Top-level run orchestration (extracted verbatim from automationRunner.js).
 *
 * executeAutomation creates the run row, builds runState + ctx, dispatches every
 * step through the engine's handlers and finalises the run (notifications,
 * schedule advancement, marker release). The rules it applies on the way — which
 * organisation a run belongs to, which port a disabled brancher passes through,
 * and the in-memory `lastOutput` on the row it returns — live here with it.
 *
 * Leaf relative to the rest of the runner: resume.js, stepAsTool.js,
 * partialRuns.js and the scheduler ticks all call INTO this module.
 *
 * This file keeps the ORDER of a run; each stage lives in its own module:
 *   runSetup.js      organisation, entered trigger, live/working copy, run
 *                    state, token vault, owner identity
 *   runHeartbeat.js  running marker, lifecycle events, heartbeat
 *   runContext.js    ctx, resume boundary, Privacy Shield gate on the payload
 *   stepDispatch.js  dispatchStep (leaf switch, forEach, pins, retries, pauses)
 *   runDeadline.js   the DAG raced against the time budget and cancel signal
 *   runFinalize.js   error class, summary, terminal row, outcome, release,
 *                    notifications, schedule advancement
 * Those modules take the collaborators inside the server's large import cycle
 * from RUN_DEPS below instead of requiring them, so they stay out of it.
 */

const automationStore = require('../../stores/automationStore');
const { buildTriggerState } = require('./triggerState');
// The run-outcome resolver is automation/'s, reached through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');
const {
    registerRunCancellation,
    clearRunCancellation,
    isCancelRequested,
} = require('./cancellation');
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
const safety = require('./safety');
const { createTokenVault, defaultPersist } = require('./tokenVault');

// §WS5 — execution primitives live in ./engine.js. Copied at load, exactly as
// the destructuring of its exports this replaced captured them.
const engine = { ...require('./engine') };
const { cloneRunValue, resolveUserSession } = engine;
// Not routed through engine.js's re-export list: only the dispatcher calls it.
const { execFlatten } = require('./execCollections');
const log = require('../../telemetry/log');
const { isManagedAutomation } = require('./stageVars');
const { notifyRunEvent } = require('./runNotifications');
const { resolveRunPolicy } = require('./runPolicy');
const { runOrgFor, resolveEnteredTrigger, selectRunCopy, buildRunState, createRunVault, resolveRunIdentity } = require('./runSetup');
const { buildRunContext, recordResumeBoundary, guardTriggerPayload } = require('./runContext');
const { harnessFor } = require('./testHarness');
const { applyCallerOnly, callerOnlyUserId, refusesMissingStarter } = require('./callerConnections');
const { blockDefinitionLoader, stepProvidersLoader } = require('./callerLookups');
const heartbeat = require('./runHeartbeat');
const { disabledPassThroughBranch, makeStepDispatcher } = require('./stepDispatch');
const { raceRunDag } = require('./runDeadline');
const { finalizeRun } = require('./runFinalize');

/**
 * What the run modules get instead of requiring it themselves. The lazy
 * loaders keep lazy what was lazily required inside executeAutomation.
 */
const RUN_DEPS = {
    automationStore,
    safety,
    engine,
    execFlatten,
    // The table steps load on first use: their readers and engine stay out of the run path until needed.
    execReadTable: (a, b, c, d, e) => require('./execReadTable').execReadTable(a, b, c, d, e),
    execTable: (a, b, c, d, e) => require('./execTable').execTable(a, b, c, d, e),
    createTokenVault,
    defaultPersist,
    notifyRunEvent,
    clearRunCancellation,
    isCancelRequested,
    loadApprovalLifecycle: () => require('./approvalLifecycle'),
    loadRunOutcome: () => runnerPort('runOutcome'),
    loadAudience: () => require('../../auth/audience'),
    loadUserStore: () => require('../../stores/userStore'),
    loadConnectionResolution: () => require('../integrations/connectionResolution'),
    loadConnectionStore: () => require('../../stores/integrationConnectionStore'),
    // The caller pre-check and the one-time notice walk a flow with the same lookups.
    loadBlockDefinition: blockDefinitionLoader(automationStore),
    loadStepProviders: stepProvidersLoader(),
};

/**
 * Trigger kinds allowed to fall back to a trigger's PINNED SAMPLE.
 *
 * BFSF-408/409/434: you could not give a node — or a trigger — a payload to
 * test against. A manual run enters at `def.trigger.id` with `trigger.output`
 * equal to `{}` no matter what, so every `{{trigger.output.*}}` in the flow
 * stayed undefined and "test this step" was untestable. The fix is trigger
 * DATA: an author pins a sample on the trigger and builder runs enter with it.
 *
 * The gate is the TRIGGER KIND, deliberately, and it is narrow:
 *
 *   - `manual_step` is the only kind on the list. Every partial run — ▶ Execute,
 *     retry-from, and "Run up to here" — is dispatched with it
 *     (routes/automation/runs.js), and nothing else in the product uses it.
 *   - `dry_run` mode joins it, because a dry run IS a preview.
 *   - `'manual'` is NOT on the list and must never be. It is the default value
 *     of the parameter, it is what the Run button sends for a real live run,
 *     and core/tools/skillInjection.js fires a LIVE production run with it from
 *     an AI agent's skill. Putting it here would feed saved sample data to
 *     production side effects.
 *   - `form` / `webhook` / `schedule` / `app_event` are real fires with real
 *     payloads and are never seeded — a live submission must win over a pin,
 *     which it does for free because a live payload short-circuits below.
 *
 * `builderRun` was the obvious-looking flag and is the wrong one: it is
 * `dry_run || onlyStepId || fromStepId` and so excludes `untilStepId` — i.e.
 * it is FALSE for "Run up to here", the exact gesture the tickets describe.
 */
const TRIGGER_PIN_KINDS = new Set(['manual_step']);

/**
 * The payload a run enters its trigger with.
 *
 * A LIVE payload always wins: a real form submission, webhook body or event
 * carries the data the run is actually about, and a saved sample must never
 * displace it. Only when nothing arrived does a builder run fall back to the
 * trigger's pinned sample.
 *
 * Resolved into `triggerPayload` ITSELF at the top of executeAutomation, not
 * into `runState.trigger.output`, and that is the whole safety argument: the
 * run row records it, the Privacy Shield scan a hundred lines down keys off the
 * same local (so a sample is scanned, audited and can be stopped by a `block`
 * policy exactly like a webhook body), and the seeding of `runState` follows.
 * Seeding runState alone would have let sample data skip the one guard on the
 * one input to an automation that nobody in the org typed.
 */
function resolveTriggerPayload({ trigger = null, triggerPayload = null, triggerKind = 'manual', mode = 'live' } = {}) {
    if (triggerPayload != null) return triggerPayload;
    if (!TRIGGER_PIN_KINDS.has(triggerKind) && mode !== 'dry_run') return triggerPayload;
    const pin = trigger?.pinnedOutput;
    if (pin === undefined || pin === null) return triggerPayload;
    // Clone: the pin lives on the automation's definition object, and a step
    // handler mutating runState.trigger.output would otherwise edit the saved
    // definition in place.
    return cloneRunValue(pin) ?? pin;
}

/** See runHeartbeat.acquireRunMarker (exported for the scheduler and tests). */
function acquireRunMarker(automationId, triggerKind, opts) {
    return heartbeat.acquireRunMarker(RUN_DEPS, automationId, triggerKind, opts);
}

async function executeAutomation(automation, { triggerKind = 'manual', triggerPayload = null, triggerHeaders = null, mode = 'live', confirmFirstRun: _confirmFirstRun = false, parentRunId = null, rootRunId = null, onRunCreated = null, onRunFinished = null, replayState = null, replayGaps = null, skipUntilStepId = null, onlyStepId = null, fromStepId = null, untilStepId = null, rootStepId = null, loopVars = null, stepRecord = null, schedule = null, isTest = false, startedByUserId = null, callerAgentId = null, callerConversationId = null, lockedConnectionsMode = null, harness = null } = {}) {
    const startedAt = Date.now();
    // ── Live or working copy (handoff 5) ── decided once, here, for every
    // caller (runSetup.selectRunCopy). From this line on `automation` is the
    // copy this run executes.
    let testRun;
    ({ automation, testRun } = await selectRunCopy(RUN_DEPS, automation, { mode, triggerKind, isTest }));
    const runPolicy = resolveRunPolicy(automation.definition);
    const session = await resolveUserSession(automation.userId);
    const runOrgId = runOrgFor(automation, session);
    // runPolicy.connections = 'caller': whose connections this run uses is
    // decided HERE, once, from the server-side starter, and stored on the run
    // row so a resume keeps it (callerConnections.js).
    const callerUserId = callerOnlyUserId(runPolicy, automation, startedByUserId, lockedConnectionsMode);
    const missingStarter = refusesMissingStarter(runPolicy, triggerKind, startedByUserId, lockedConnectionsMode);


    // First-run confirmation gate removed by product decision — every run
    // executes in the requested mode. Local vars kept (always false) so the
    // surrounding code paths that reference them stay readable; they'll be
    // dead-code-eliminated by any future cleanup pass.
    const effectiveMode = mode;
    const firstRunNeedsConfirm = false;

    // ── The trigger's pinned sample (BFSF-408/409/434) ────────────────────
    // Resolved HERE — before createRun, before runState, before the Privacy
    // Shield scan — so every one of those sees the same payload. See
    // resolveTriggerPayload for why this is not done at the runState line, and
    // TRIGGER_PIN_KINDS for why the gate is the trigger kind and not
    // `builderRun`.
    const enteredTrigger = resolveEnteredTrigger(automation.definition, rootStepId);
    triggerPayload = resolveTriggerPayload({ trigger: enteredTrigger, triggerPayload, triggerKind, mode: effectiveMode });

    // Create a run row (queued → running).
    const run = await automationStore.createRun({
        automationId: automation.id,
        version: automation.version,
        userId: automation.userId,
        triggerKind: firstRunNeedsConfirm ? 'first_run_confirm' : triggerKind,
        triggerPayload,
        mode: effectiveMode,
        parentRunId,
        rootRunId,
        // Which trigger node the run entered through — what a resume after a
        // pause needs to re-enter the same root (resume.js).
        rootStepId: enteredTrigger?.id ?? null,
        isTest: testRun,
        startedByUserId,
        callerAgentId,
        callerConversationId,
        connectionsMode: callerUserId ? 'caller' : null,
    });

    // The run row EXISTS now — which is a different moment from "this call
    // returned", and the only moment a caller can act on while the run is still
    // going. The public form uses it to point the visitor's session at the leg
    // doing the work; without it the session only learns the run id once the
    // run has already paused or finished, so the poll could never report
    // progress. Best-effort by construction: a caller's bookkeeping must not
    // take a run down with it.
    if (typeof onRunCreated === 'function') {
        try { await onRunCreated(run); } catch (e) {
            log.warn(`[automationRunner] onRunCreated hook failed for run ${run.id}: ${e.message}`);
        }
    }

    const emitLifecycle = heartbeat.makeLifecycleEmitter({ run, automation, effectiveMode });

    // Register a cancellation controller for this run. The cancel endpoint
    // sets cancel_requested=TRUE in the DB and aborts this controller so
    // both in-process and cross-process cancellations are honoured.
    const cancelController = registerRunCancellation(run.id);
    const cancelSignal = cancelController.signal;

    // §WS2.4 concurrency guard (runHeartbeat.claimRunMarker). A RESUME is not a
    // new trigger: it continues alongside whatever holds the marker.
    const isResume = !!skipUntilStepId;
    const claim = await heartbeat.claimRunMarker(RUN_DEPS, { automation, run, runPolicy, triggerKind, effectiveMode, isResume, startedAt, emitLifecycle });
    if (claim.skipped) return claim.row;
    const ownsMarker = claim.ownsMarker;

    await automationStore.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    emitLifecycle('run.started', {
        triggerKind, mode: effectiveMode, title: automation.title || null,
        kind: automation.kind || 'automation', version: automation.version,
    });
    const touchRunMarker = heartbeat.makeRunMarkerToucher(RUN_DEPS, { ownsMarker, automation });
    const heartbeatTimer = heartbeat.startHeartbeat(RUN_DEPS, { effectiveMode, emitLifecycle, run, touchRunMarker });

    const runState = await buildRunState(RUN_DEPS, { enteredTrigger, triggerKind, triggerPayload, triggerHeaders, schedule, startedAt, replayState, automation, loopVars });
    const tokenVault = await createRunVault(RUN_DEPS, { parentRunId, run, runOrgId, automation, effectiveMode });
    const identity = await resolveRunIdentity(RUN_DEPS, automation);
    const ctx = buildRunContext({
        automation, runOrgId, isResume, session, run, tokenVault, runPolicy, stepRecord,
        effectiveMode, onlyStepId, fromStepId, emitLifecycle, enteredTrigger, identity,
    });

    // runPolicy.connections = 'caller': the starter's own connections, or no run.
    const callerGate = await applyCallerOnly(RUN_DEPS, {
        callerUserId, missingStarter, automation, runOrgId, effectiveMode, locked: !!lockedConnectionsMode,
        failCtx: { run, heartbeatTimer, startedAt, automation, ownsMarker, emitLifecycle },
    });
    if (callerGate.failedRow) return callerGate.failedRow;
    if (callerGate.identity) {
        ctx.callerOnly = callerGate.identity;
        // The owner's session no longer describes this run's connections.
        const cs = callerGate.identity.session;
        ctx.nextcloudUrl = cs?.connectorNcBaseUrl || cs?.nextcloudUrl || null;
    } else {
        ctx.callerOnly = null;
    }
    ctx.startedByUserId = startedByUserId || null;
    // Test harness (golden replay, form scenario): dry runs only, null otherwise.
    ctx.testHarness = harnessFor(effectiveMode, harness);

    await recordResumeBoundary(RUN_DEPS, { skipUntilStepId, replayState, effectiveMode, automation, run, runState });
    const shield = await guardTriggerPayload(RUN_DEPS, { triggerPayload, triggerKind, ctx, runState, effectiveMode, run, heartbeatTimer, startedAt, automation, ownsMarker, emitLifecycle });
    if (shield.blocked) return shield.row;

    const dispatchStep = makeStepDispatcher(RUN_DEPS, { run, cancelSignal, runPolicy });
    const outcome = await raceRunDag(RUN_DEPS, {
        automation, ctx, runState, effectiveMode, dispatchStep, runPolicy, run,
        cancelController, cancelSignal, heartbeatTimer, touchRunMarker,
        skipUntilStepId, onlyStepId, fromStepId, untilStepId, rootStepId, replayGaps,
    });

    return finalizeRun(RUN_DEPS, {
        automation, run, ctx, runState, tokenVault, startedAt, firstRunNeedsConfirm, outcome,
        ownsMarker, schedule, rootStepId, triggerKind, effectiveMode, testRun,
        onRunFinished, emitLifecycle,
    });
}

module.exports = { runOrgFor, isManagedAutomation, disabledPassThroughBranch, resolveEnteredTrigger, resolveTriggerPayload, buildTriggerState, acquireRunMarker, executeAutomation };

/**
 * @typedef {object} ExecuteOptions
 * @property {string} [triggerKind]
 * @property {unknown} [triggerPayload]
 * @property {Record<string, string> | null} [triggerHeaders]
 * @property {string} [mode]
 * @property {boolean} [confirmFirstRun]
 * @property {string | null} [parentRunId]
 * @property {string | null} [rootRunId]
 * @property {((run: Record<string, any>) => unknown) | null} [onRunCreated]
 * @property {((row: Record<string, any>) => unknown) | null} [onRunFinished]
 * @property {Record<string, any> | null} [replayState]
 * @property {Map<string, number | null> | null} [replayGaps]
 * @property {string | null} [skipUntilStepId]
 * @property {string | null} [onlyStepId]
 * @property {string | null} [fromStepId]
 * @property {string | null} [untilStepId]
 * @property {string | null} [rootStepId]
 * @property {Record<string, unknown> | null} [loopVars]
 * @property {{ prefix: string, parentStepId: string | null, suppress: boolean } | null} [stepRecord]
 * @property {Record<string, any> | null} [schedule]
 * @property {boolean} [isTest]
 * @property {string | null} [startedByUserId]
 * @property {string | null} [callerAgentId]
 * @property {string | null} [callerConversationId]
 * @property {string | null} [lockedConnectionsMode]
 * @property {Parameters<typeof harnessFor>[1]} [harness]
 */
