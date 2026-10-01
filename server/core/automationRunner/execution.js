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
 */

const crypto = require('crypto');
const automationStore = require('../../stores/automationStore');
const { sanitizeError } = require('../privacy/errorSanitizer');
const { classifyUnknownError, remediationFor } = require('../automationErrors');
const { safeDescribeStepError } = require('../../utils/stepErrorInfo');
const { resolveDeep } = require('../../automation/bind');
const { summariseDefinition } = require('../../automation/summarise');
const holidays = require('../../automation/holidays');
const { buildTriggerState } = require('./triggerState');
const runEventBus = require('../runEventBus');
const {
    registerRunCancellation,
    clearRunCancellation,
    isCancelRequested,
} = require('./cancellation');
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
const safety = require('./safety');
const { createTokenVault, defaultPersist } = require('./tokenVault');

// §WS5 — execution primitives live in ./engine.js.
const {
    INSTANCE_ID,
    MASK_VALUES,
    clampRunTimeout,
    cloneRunValue,
    secretValuesFor,
    resolveUserSession,
    execIntegrationAction,
    execAiStep,
    execCondition,
    execGuard,
    execTokenize,
    execUntokenize,
    execNotification,
    execCode,
    execHttpRequest,
    execGenerateDocument,
    execFillDocument,
    execSlide,
    execPresentation,
    ApprovalRequiredError,
    execApproval,
    FormInputRequiredError,
    execFormPage,
    execParallel,
    execLoop,
    execForEachStep,
    execCallLayer,
    execLayerOutput,
    execCallBlock,
    execSet,
    execParseJson,
    execDateTime,
    execWait,
    execStopError,
    execReturnToApp,
    execSwitch,
    execFilter,
    execLimit,
    execDedupe,
    execAggregate,
    execSummarize,
    execDatatable,
    execKnowledgeWrite,
    execDataExtraction,
    runDag,
} = require('./engine');
const { createToolMemo } = require('./toolMemo');
// step.repeat, the v2 per-item repeat (the legacy forEach is execForEachStep).
const { execRepeatStep } = require('./execRepeat');
const { recordedRunWarnings } = require('./runWarnings');
const log = require('../../telemetry/log');
// Handoff 5: which copy a run executes (live vs working) and the routine's
// run policy (default retry, time budget, concurrency).
const { automationForRun, isTestRun } = require('./definitionForRun');
const { notifyRunEvent } = require('./runNotifications');
const { resolveRunPolicy, stepRetryFor, runTimeoutMsFor } = require('./runPolicy');

/**
 * Which organisation a run belongs to: the routine's own, else its OWNER's.
 *
 * `automations.organization_id` is never written — routes/automation/crud.js
 * creates with `userId` only — so this was null for every routine ever made,
 * and everything hanging off ctx.orgId ran with no organisation. resolveOrgShield
 * bails on a falsy id, so the org Privacy Shield (including its "Also protect
 * routines" switch, which reads as ON in the settings page) applied to nothing
 * at all. The guardrail audit rows and the audience checks were equally org-less.
 *
 * The owner's org is the same answer every other surface resolves for that
 * person, and resolveUserSession had already read it for its OAuth work — it
 * simply was not being asked for.
 *
 * A fallback, never an override: a routine deliberately scoped to one
 * organisation must not drift to another when its author's membership changes.
 */
function runOrgFor(automation, session) {
    return automation?.organizationId || session?.user?.organizationId || null;
}

/**
 * The step's inputs as run history records them. Silent: this is a record of
 * what the step got, made after (or instead of) the step's own resolve, so a
 * value it did not get is already a run warning and must not become a second.
 */
function snapshotInputs(step, state) {
    return step.inputs ? resolveDeep(step.inputs, state, { allowSecrets: false, silent: true }) : null;
}

/**
 * The branch label a DISABLED brancher routes on, or null for a plain step.
 *
 * A disabled step returns `{disabled: true}` and nothing else, so runDag found
 * no `branch` on it and fell back to 'on_success' — which matches none of an
 * If/Switch/Guard's then/else/case:* edges. Disabling one of those therefore
 * ended the whole run right there, status success, no warning: everything after
 * the node silently stopped existing (W4-11).
 *
 * The semantic chosen here is "a disabled node is not there": it passes through
 * on its CONTINUE port — `then` for condition/guard (the same port
 * buildLinearEdges uses to continue a linear body past a brancher), and the
 * configured `defaultBranch` (else the default port) for a switch. Passing
 * through EVERY outgoing branch edge was the alternative and was rejected: it
 * would run both sides of an If at once and duplicate whatever side effects
 * hang off them, which is a worse surprise than the one being fixed.
 *
 * If that port has no edge, runDag's default-port rescue and its dead-end
 * breadcrumb take it from there — the run says so instead of ending silently.
 */
function disabledPassThroughBranch(step) {
    if (step.type === 'condition' || step.type === 'guard') return 'then';
    if (step.type === 'switch') return `case:${step.defaultBranch || 'default'}`;
    return null;
}

/**
 * Which trigger did this run enter through?
 *
 * A routine may declare extra entry points in `definition.triggers[]`; whoever
 * dispatched the run names the one that fired via `rootStepId`. Everything else
 * enters at the primary `definition.trigger`.
 *
 * Hoisted out of the `formBaseTheme` getter it used to live inside, because a
 * second place now needs the same answer (the pinned-sample seeding below) and
 * a hand-written copy of this lookup is exactly how the two would come to
 * disagree about which trigger a run belongs to — one serving trigger A's form
 * theme while the other served trigger B's sample.
 */
function resolveEnteredTrigger(def, rootStepId = null) {
    const triggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])];
    const entered = rootStepId ? triggers.find(t => t?.id === rootStepId) : def?.trigger;
    return entered || def?.trigger || null;
}

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
 * A live run that finds its routine ALREADY RUNNING.
 *
 * The routine-level marker (`automations.last_status = 'running'`) allows one
 * live run at a time, and a second one used to be cancelled on the spot —
 * "Skipped: automation already running". For a manual click that is the right
 * answer. For an EVENT it is data loss: the Gmail poller has already advanced
 * its cursor, so the mail that arrived while a briefing was running is never
 * triaged. With several triggers on one routine those collisions stop being
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

async function acquireRunMarker(automationId, triggerKind, { wait = true } = {}) {
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
 * one input to a routine that nobody in the org typed.
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

async function executeAutomation(automation, { triggerKind = 'manual', triggerPayload = null, triggerHeaders = null, mode = 'live', confirmFirstRun: _confirmFirstRun = false, parentRunId = null, rootRunId = null, onRunCreated = null, onRunFinished = null, replayState = null, replayGaps = null, skipUntilStepId = null, onlyStepId = null, fromStepId = null, untilStepId = null, rootStepId = null, loopVars = null, stepRecord = null, schedule = null, isTest = false, startedByUserId = null, callerAgentId = null, callerConversationId = null } = {}) {
    const startedAt = Date.now();
    // ── Live or working copy (handoff 5) ──────────────────────────────────
    // Test runs (dry run, partial builder runs, the Test button's `isTest`)
    // execute the WORKING copy; every other run executes the LIVE copy when
    // the routine has one. Decided once, here, for every caller — see
    // definitionForRun.js. From this line on `automation.definition` and
    // `automation.version` are the copy this run executes, so the run row
    // records the version that actually ran.
    const testRun = isTestRun({ mode, triggerKind, isTest });
    automation = automationForRun(automation, { mode, triggerKind, isTest });
    const runPolicy = resolveRunPolicy(automation.definition);
    const session = await resolveUserSession(automation.userId);
    const runOrgId = runOrgFor(automation, session);


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

    // Live run-lifecycle events for the executions UI's SSE stream. Skipped for
    // dry-runs (the executions table only shows live runs) and never allowed to
    // throw — emission must not break a run. Stamped with userId so the stream
    // route can scope events per-user, + automationId so a single-surface view
    // can filter. Attached to ctx so runDag can emit step.* with the same shape.
    const emitLifecycle = (type, extra = {}) => {
        if (effectiveMode === 'dry_run') return;
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
        } catch (_) { /* never break a run on telemetry */ }
    };

    // Register a cancellation controller for this run. The cancel endpoint
    // sets cancel_requested=TRUE in the DB and aborts this controller so
    // both in-process and cross-process cancellations are honoured.
    const cancelController = registerRunCancellation(run.id);
    const cancelSignal = cancelController.signal;

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
    // the same routine happened to hold the marker at that moment, the approved
    // continuation was finalised as 'cancelled' having dispatched nothing. The
    // approve endpoint has already consumed the single-use token and stamped
    // the parent 'success' by then, and no endpoint can re-issue it, so the
    // approved work was simply lost. The run being resumed was accounted for
    // when it was triggered, and its marker was released when it PAUSED, so
    // there is nothing left to deduplicate: continue, but WITHOUT claiming
    // ownership of a marker another run holds (releasing it in the finally
    // would clear it out from under that run — the very hazard the guard
    // exists to prevent).
    const isResume = !!skipUntilStepId;
    // runPolicy.concurrency 'parallel' (handoff 5): a live run that finds the
    // routine busy runs ALONGSIDE it, exactly the way a resume does — it
    // takes the marker when it is free and never waits for it, and when it is
    // not free it runs without owning it (so it cannot release it from under
    // the run that does). 'serial' (the default) is today's behaviour.
    const parallel = runPolicy.concurrency === 'parallel';
    let ownsMarker = effectiveMode === 'live';
    if (triggerKind !== 'schedule' && effectiveMode === 'live') {
        // Event/webhook runs wait (bounded) for a busy routine instead of
        // being dropped — see acquireRunMarker. A resume never waits.
        const acquired = await acquireRunMarker(automation.id, triggerKind, { wait: !isResume && !parallel });
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
            }).catch(() => {});
            await writeRunOutcome({ runId: run.id, status: 'cancelled', cancelReason: 'already_running' });
            clearRunCancellation(run.id);
            emitLifecycle('run.started', { triggerKind, mode: effectiveMode, title: automation.title || null, kind: automation.kind || 'automation', version: automation.version });
            emitLifecycle('run.finished', { status: 'cancelled', durationMs: Date.now() - startedAt });
            return withLastOutput(await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'cancelled' })), null);
        }
    }

    await automationStore.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    emitLifecycle('run.started', {
        triggerKind, mode: effectiveMode, title: automation.title || null,
        kind: automation.kind || 'automation', version: automation.version,
    });
    // Keep the AUTOMATIONS-row running marker fresh (A8 / W5-16).
    //
    // The run row has a heartbeat; the automations row had only
    // `running_started_at`, stamped once at claim time, and reapStuckAutomations
    // resets any row older than max(REAPER_FLOOR_MS, run_timeout_ms +
    // REAPER_BUFFER_MS) — at most ~61 minutes. A Wait step, meanwhile, extends
    // only the IN-PROCESS deadline (ctx.extendRunDeadline) and can legitimately
    // sleep for up to 24 hours. So a long wait had the row reaped out from
    // under a perfectly healthy run: the concurrency marker went away, and the
    // scheduler started a SECOND run of the same routine while the first was
    // still sleeping. Refreshing the marker from the same heartbeat that keeps
    // the run row alive makes both clocks derive from one fact — this runner
    // process is still here — instead of from two unrelated numbers. A crashed
    // pod stops heartbeating and is still reaped exactly as before.
    const touchRunMarker = () => {
        if (!ownsMarker) return;
        // Capability-checked: a store build without the marker touch keeps the
        // old behaviour rather than throwing on every heartbeat tick.
        try { automationStore.touchAutomationRunning?.(automation.id, INSTANCE_ID)?.catch?.(() => {}); }
        catch (_) { /* the marker refresh must never break a run */ }
    };
    // Heartbeat (live runs only): keeps the SSE stream warm AND stamps
    // last_heartbeat_at so the stuck-run reaper sees the run as alive.
    const heartbeatTimer = (effectiveMode === 'dry_run') ? null : setInterval(() => {
        emitLifecycle('step.heartbeat', { at: new Date().toISOString() });
        automationStore.touchRunHeartbeat(run.id).catch(() => {});
        touchRunMarker();
    }, 15_000);
    if (heartbeatTimer?.unref) heartbeatTimer.unref();

    const runState = {
        // trigger.output IS the raw trigger payload (for webhooks: the POSTed
        // JSON body — no wrapper). Headers ride OUTSIDE output, at
        // trigger.headers, so they can never collide with body fields and
        // existing trigger.output.<field> bindings stay valid (A14).
        // Beside `output`, the run also learns WHICH trigger fired and how:
        // trigger.kind / .source / .id / .provider / .event / .firedAt /
        // .schedule (triggerState.js). Meta stays outside `output` so the
        // Privacy Shield rewrite below and every payload scan leave it alone.
        trigger: buildTriggerState({ enteredTrigger, triggerKind, triggerPayload, triggerHeaders, schedule, startedAt }),
        // Hydrate from a previous run's recorded outputs when resuming —
        // bindings like {{steps.stepA.output.field}} need the values the
        // original run produced. Deep-clone the replay snapshot so step
        // handlers can't mutate the persisted prior-run rows.
        steps: replayState ? (cloneRunValue(replayState) || {}) : {},
        vars: automation.definition?.vars || {},
        secrets: {}, // populated by sandbox/secret bridges only; never echoed
        // Symbol-keyed mask needles from http_request credential injection.
        // Unreachable from {{…}} templates / exprs / code steps (string-path
        // walkers); folded into secretValuesFor at the recordRunStep
        // chokepoint. Sub-states share this array by reference.
        [MASK_VALUES]: [],
        // Normally filled per iteration by execLoop / execForEachStep. Seeded
        // up-front for ONE case: a partial run of a step that lives inside a
        // loop body, where the surrounding iteration is what gives the step its
        // input (runPartialInLoopBody).
        loop: loopVars ? (cloneRunValue(loopVars) || {}) : {},
        // When non-null, interpolateTemplate pushes unresolved paths here, and
        // bind.js / runDag push their warnings, so the runner records one
        // warning list per run (warnings_json, see runWarnings.js) instead
        // of silently swallowing missing bindings.
        _templateWarnings: [],
        // The JSON texts a pick binding has parsed this run (walk.mjs), so a
        // large API answer is parsed once however many fields read into it.
        // Sub-states share it by reference, like _templateWarnings.
        _mappingMemo: new Map(),
        // §WS4: every step failure absorbed by an on_error branch lands here
        // ({stepId, message, errorClass}). Layer/loop/parallel sub-states
        // carry the SAME array reference, so nested handled errors surface
        // in the run summary + handled_error_count too.
        _handledErrors: [],
    };

    // ── Run-scoped PII token vault ────────────────────────────────────────
    // ONE token namespace for the whole run. Every tokenize call is seeded from
    // it, so a value keeps in node 5 the placeholder it got in node 1, and every
    // restore point holds the complete map — a tokenized value can no longer
    // become unrestorable (which is exactly how `[person_1]` used to end up in
    // outgoing emails). Container steps shallow-copy ctx, so parallel branches,
    // loop iterations and sub-layers all share this same object.
    //
    // Seeded from the run being replayed (approval resume / retry-from-step):
    // that run may have minted placeholders in another process.
    let vaultSeed = null;
    if (parentRunId && typeof automationStore.getRunTokenMap === 'function') {
        vaultSeed = await Promise.resolve(automationStore.getRunTokenMap(parentRunId)).catch(() => null);
    }
    const tokenVault = createTokenVault({
        runId: run.id,
        seed: vaultSeed,
        persist: defaultPersist,
        onEvict: () => {
            // A dropped placeholder is a real (if rare) loss of restorability —
            // audit it instead of only warning to stdout.
            try {
                require('../../stores/guardrailEventStore').logGuardrailEvent({
                    organization_id: runOrgId,
                    user_id: automation.userId || null,
                    agent_id: null,
                    agent_name: automation.title || null,
                    conversation_id: automation.id,
                    automation_id: automation.id,
                    run_id: run.id,
                    step_id: null,
                    source: 'routine',
                    violation_type: 'pii',
                    violation_categories: 'token_evicted',
                    direction: 'output',
                    action_taken: 'redacted',
                    is_dry_run: effectiveMode === 'dry_run',
                }).catch(() => {});
            } catch (_) { /* never fail a run on audit logging */ }
        },
    });

    // Resolve the automation owner's groups once per run. Used by webpage
    // tools (and any future tool) to check shared/published visibility
    // outside the request-scoped audience helpers.
    let runUserGroupIds = [];
    // The owner's org role and home organisation come from the SAME user read
    // the groups need, so this costs no extra query. A datatable step needs all
    // three: the grade resolver anchors an org-admin role to the org that role
    // was granted in, and orgId alone cannot tell it apart from a role carried
    // over from a previous employer.
    //
    // The HTTP half of this is auth/datatableAccess.resolveDatatablePrincipal.
    // Both read the same three fields fresh from `users`, and they must keep
    // agreeing: the moment one of them starts trusting a session or a run
    // snapshot, a routine can write rows its author cannot see.
    let runUserOrgRole = null;
    let runUserHomeOrgId = null;
    // A FAILURE here is recorded, not swallowed. Tolerating it is right for the
    // webpage tools (an empty group list narrows what they show), and wrong for
    // a datatable: an unresolved orgRole degrades to "not an admin" and an
    // unresolved group list to "in no group", so a step that worked yesterday
    // fails today as `datatable_forbidden` — an authorisation refusal for what
    // is really a lookup outage, with nothing anywhere saying so. execDatatable
    // reads this and fails with `datatable_identity_unavailable` instead.
    let runIdentityError = null;
    try {
        const { resolveUserGroups } = require('../../auth/audience');
        runUserGroupIds = await resolveUserGroups(automation.userId);
        const userStore = require('../../stores/userStore');
        const owner = await userStore.getUser(automation.userId);
        runUserOrgRole = owner?.orgRole || null;
        runUserHomeOrgId = owner?.organizationId || null;
    } catch (e) { runIdentityError = e?.message || 'identity lookup failed'; }

    const ctx = {
        userId: automation.userId,
        orgId: runOrgId,
        userGroupIds: runUserGroupIds,
        orgRole: runUserOrgRole,
        userHomeOrgId: runUserHomeOrgId,
        // Non-null when the three fields above could not be read. Only the
        // datatable step acts on it; everything else keeps its tolerant
        // behaviour.
        identityError: runIdentityError,
        // "Ask this app only once per run" (step.askOnce, off unless set).
        // Created HERE, in the ctx object literal, and never lazily: container
        // steps shallow-copy ctx (execFlow does {...ctx, _branchIndex}), so a
        // lazy assignment first reached inside a parallel branch would land on
        // that branch's COPY and be invisible to its siblings — the same trap
        // ctx.allowedToolNames falls into.
        //
        // startSlept on a RESUME: this leg continues a run that stopped on an
        // approval or a form page, and that gap waits on a person — days, not
        // the half-minute a Wait usually is. A Wait already closes the durable
        // cross-run tier for the rest of the run (memo.clear sets the flag);
        // without this line the far longer pause reopened it, because a resume
        // arrives here with a brand-new memo. Every resumed leg re-enters
        // through resumeFromStep with skipUntilStepId set, so a run that pauses
        // twice stays closed for all of its later segments.
        _toolMemo: createToolMemo({ startSlept: isResume }),
        userOrgIds: runOrgId ? [runOrgId] : [],
        session,
        runId: run.id,
        // The journey this run belongs to (a resumed form/approval leg has a
        // root). Tool executors read it to resolve `generated_file` handles
        // against exactly the runs this journey may see.
        rootRunId: run.rootRunId || run.id,
        // First-run guard removed; field kept for shape compatibility with
        // any callers that read it. Always false now.
        needsFirstRunConfirm: false,
        automationId: automation.id,
        // Title is used as the agent_name surrogate in egress/guardrail rows.
        automationTitle: automation.title || null,
        // Shared by reference with every branch/iteration/sub-layer ctx copy.
        tokenVault,
        // Best-effort NC base URL so egress rows carry a destination for
        // nextcloud_* tools (the probe captures the real peer IP regardless).
        nextcloudUrl: session?.connectorNcBaseUrl || session?.nextcloudUrl || automation.nc_base_url || null,
        // The full draft is needed by execAiStep so it can auto-derive an
        // outputSchema from downstream refs — without this, an ai_step that
        // produces structured fields ("replyText", "summary", etc.) just
        // returns plain text and downstream bindings silently resolve to
        // undefined, breaking integration steps with cryptic "X is required"
        // errors instead of producing useful output.
        definition: automation.definition || {},
        // The routine's run policy (runPolicy.js). runDag reads
        // retry.then === 'continue' to carry on past a step that failed
        // for good; shallow ctx copies (layers, loops, branches) share it.
        runPolicy,
        // Inline layers (root-only map of mini-definitions). execCallLayer
        // resolves step.layerKey against this — no DB fetch.
        layers: automation.definition?.layers || {},
        // Sub-step recording context. execCallLayer derives a child with
        // prefix '<callStepId>/' + parentStepId; execLoop suppresses for
        // its body (parity with the previously-unrecorded loop bodies).
        // Seeded by runPartialInLoopBody so the one body step it runs is
        // recorded under the id the canvas addressed it by ('<loopId>/<stepId>').
        stepRecord: stepRecord || { prefix: '', parentStepId: null, suppress: false },
        // Builder-initiated run (dry-run, or a single-step ▶ Execute /
        // retry-from). The canvas-only PII scan of step outputs runs ONLY in
        // these — production runs never pay for it (owner decision).
        builderRun: effectiveMode === 'dry_run' || !!(onlyStepId || fromStepId),
        // Live SSE emitter (no-op for dry-run) so runDag can stream step.*.
        emitLifecycle,
        // Dry-run taint root: an event/webhook trigger has no real payload in
        // a dry-run (whatever is bound is a synthesized/model-provided
        // sample), so reads that bind trigger.output.* must synthesize
        // instead of dispatching fake ids live. Schedule/manual triggers
        // legitimately carry no payload → not synthetic.
        // Keyed off the trigger the run ENTERED through: a dry run of a
        // secondary app-event trigger under a manual primary must synthesize
        // too, or it would dispatch its fake ids live.
        triggerSynthetic: effectiveMode === 'dry_run'
            && ['app_event', 'webhook'].includes(enteredTrigger?.kind || ''),
        // Theme a form_page step inherits when it declares none of its own, so
        // page 2 of a form looks like page 1 without the author restyling it.
        // Read from the trigger the run actually entered through (rootStepId),
        // falling back to the primary trigger.
        formBaseTheme: enteredTrigger?.form?.theme || null,
    };

    // ── Persist the resumption boundary ───────────────────────────────────
    // resumeFromStep injects the thing the run was waiting for (an approver's
    // decision, a visitor's form answers) as the paused step's synthetic
    // output. runDag REPLAYS that step without recording it, so without this
    // row the injected value exists nowhere durable: run history shows a gap,
    // and a SECOND pause later in the same flow would resume with page one's
    // answers already lost. Recording it up-front (not after the DAG settles)
    // also means a crash mid-resume still leaves the audit trail intact.
    if (skipUntilStepId && replayState && replayState[skipUntilStepId] && effectiveMode === 'live') {
        const boundary = replayState[skipUntilStepId];
        const node = (automation.definition?.steps || []).find(s => s?.id === skipUntilStepId);
        const now = new Date().toISOString();
        await automationStore.recordRunStep({
            runId: run.id, stepId: skipUntilStepId, parentStepId: null,
            stepType: node?.type || 'approval', attempts: 1,
            status: 'success', startedAt: now, finishedAt: now,
            input: null, output: boundary.output ?? null, error: null,
            secretValues: secretValuesFor(runState),
        }).catch((e) => log.warn(`[AutomationRunner] could not record resume boundary ${skipUntilStepId}: ${e.message}`));
    }

    // ── Safety: scan the trigger payload ──────────────────────────────────
    // The raw webhook body / event payload used to land in runState completely
    // unseen — it is the one input to a routine nobody in this org typed, and
    // it was the only entry point with no guard at all. Scanning it here also
    // gives every value in it a stable placeholder for the whole run, and lets
    // a `block` policy stop the run before step 1 does anything.
    //
    // runState keeps real values (see the vault contract); this is detection,
    // audit and token seeding, not transformation.
    if (triggerPayload && typeof triggerPayload === 'object' && Object.keys(triggerPayload).length) {
        try {
            const triggerPolicy = await safety.resolveAutomationPolicy(ctx);
            if (triggerPolicy.piiEnabled || triggerPolicy.regexRules.length) {
                const triggerAudit = safety.buildAuditBase(ctx, { id: `trigger:${triggerKind}` });
                const guardedTrigger = await safety.guardToolInput(triggerPayload, triggerPolicy, triggerAudit, effectiveMode, ctx);
                // Regex rules redact irreversibly — keep that redaction. PII is
                // tokenized into the vault and restored straight back.
                runState.trigger.output = safety.restoreForRunState(guardedTrigger.value, ctx);
            }
        } catch (e) {
            if (e && e.guardrailBlocked) {
                // Fail the run before any step touches the payload.
                clearRunCancellation(run.id);
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                await automationStore.updateRun(run.id, {
                    status: 'error', finishedAt: new Date().toISOString(),
                    durationMs: Date.now() - startedAt,
                    error: e.message, errorClass: 'guardrail_blocked',
                    summary: `Failed: ${e.message}`,
                }).catch(() => {});
                await writeRunOutcome({
                    runId: run.id, status: 'error', definition: automation.definition,
                    error: { message: e.message, errorClass: 'guardrail_blocked' },
                });
                if (ownsMarker) {
                    await automationStore.updateAutomation(automation.id, {
                        lastStatus: 'error', lastRunAt: new Date().toISOString(),
                    }, automation.userId).catch(() => {});
                    await automationStore.releaseAutomation(automation.id).catch(() => {});
                }
                emitLifecycle('run.failed', { status: 'error', errorClass: 'guardrail_blocked', error: e.message, durationMs: Date.now() - startedAt });
                return withLastOutput(await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'error' })), null);
            }
            throw e;
        }
    }

    // Dispatch a single step by type — no iteration. Container/control
    // steps (loop, parallel, call_layer) recurse via the `dispatchStep`
    // closure below. Referencing `dispatchStep` here is safe: it's only
    // *called* at run time, by when the const is assigned.
    const runStepLeaf = async (step, ctx_, state_, mode_) => {
        switch (step.type) {
            case 'integration_action': return execIntegrationAction(step, ctx_, state_, mode_);
            case 'ai_step':            return execAiStep(step, ctx_, state_, mode_);
            case 'condition':          return execCondition(step, ctx_, state_);
            // Scans a value with the Privacy Shield's own detector and branches
            // on the answer (then = personal data, else = clean).
            case 'guard':              return execGuard(step, ctx_, state_, mode_);
            // Reversible placeholders minted into the run vault; the
            // runner's existing restore points put the real values back.
            case 'tokenize':           return execTokenize(step, ctx_, state_, mode_);
            // Put the real values back HERE. The runner restores automatically
            // wherever a value round-trips (AI reply, tool result); this is for
            // the values that never do.
            case 'untokenize':         return execUntokenize(step, ctx_, state_);
            case 'loop':               return execLoop(step, ctx_, state_, mode_, dispatchStep);
            case 'code':               return execCode(step, ctx_, state_, mode_);
            case 'notification':       return execNotification(step, ctx_, state_, mode_);
            case 'http_request':       return execHttpRequest(step, ctx_, state_, mode_);
            case 'generate_document':  return execGenerateDocument(step, ctx_, state_, mode_);
            // Fills a Document DESIGNED in Studio (an invoice, a quote, a
            // letter on letterhead) and keeps the PDF. generate_document above
            // is its sibling for the other direction: text in, standard layout.
            case 'fill_document':      return execFillDocument(step, ctx_, state_, mode_);
            // The presentation pair: a slide is an object (pure, forEach-able),
            // the deck is a kept file — same ledger as generate_document.
            case 'slide':              return execSlide(step, ctx_, state_, mode_);
            case 'presentation':       return execPresentation(step, ctx_, state_, mode_);
            case 'approval':           return execApproval(step, ctx_, state_, mode_);
            case 'form_page':          return execFormPage(step, ctx_, state_, mode_);
            case 'parallel':           return execParallel(step, ctx_, state_, mode_, dispatchStep);
            case 'call_layer':         return execCallLayer(step, ctx_, state_, mode_, dispatchStep);
            case 'call_block':         return execCallBlock(step, ctx_, state_, mode_, dispatchStep);
            case 'layer_output':       return execLayerOutput(step, ctx_, state_);
            // n8n-style utility nodes
            case 'set':                return execSet(step, ctx_, state_);
            case 'parse_json':         return execParseJson(step, ctx_, state_, mode_);
            case 'datetime':           return execDateTime(step, ctx_, state_);
            case 'wait':               return execWait(step, ctx_, state_, mode_);
            case 'stop_error':         return execStopError(step, ctx_, state_);
            // The other TERMINAL step. Unlike stop_error it does NOT throw —
            // it ends the run successfully and its output carries the
            // instructions the app applies (`_appEffects`). The walk stopping
            // afterwards is runDag's job, not this switch's.
            case 'return_to_app':      return execReturnToApp(step, ctx_, state_);
            case 'switch':             return execSwitch(step, ctx_, state_);
            case 'filter':             return execFilter(step, ctx_, state_);
            case 'limit':              return execLimit(step, ctx_, state_);
            case 'dedupe':             return execDedupe(step, ctx_, state_);
            case 'aggregate':          return execAggregate(step, ctx_, state_);
            case 'summarize':          return execSummarize(step, ctx_, state_);
            // One of the two steps whose effect outlives the run: rows in an
            // organisation-scoped table, reached through the shared engine.
            case 'datatable':          return execDatatable(step, ctx_, state_, mode_);
            // The other one whose effect outlives the run — and the one whose
            // text an agent will later state as fact, which is why its
            // knowledge base is re-authorised at run time rather than trusted
            // from the definition.
            case 'knowledge_write':    return execKnowledgeWrite(step, ctx_, state_, mode_);
            // Named, typed fields out of a piece of text. Runs on the ONE
            // extraction model the admin configured, never the routine's
            // tier; a dry run synthesises typed samples and never calls it.
            case 'data_extraction':    return execDataExtraction(step, ctx_, state_, mode_);
            // A canvas annotation (BFSF-411) — never reachable in practice
            // (it carries no edges, so runDag never queues it; a nested one
            // is excluded from execFlow.js's buildLinearEdges the same way),
            // but the switch's OWN contract is "never throw for a persisted
            // note step", so this case stands as the second half of that
            // guarantee rather than relying on unreachability alone.
            case 'note':               return { output: null, skippedReason: 'note' };
            default: throw new Error(`Unknown step type: ${step.type}`);
        }
    };

    // Wrap a leaf step with optional per-item iteration. When `step.repeat`
    // (v2) or `step.forEach` (legacy) is set the step runs once per item (see
    // execRepeat.js / execForEachStep); otherwise it runs once. repeat is
    // checked first: a step the editor converted keeps working even if an
    // old forEach was left beside it (the validator warns about that). Both
    // the initial dispatch and the retry path route through here so
    // iteration composes with retry / on_error.
    const executeStepWithIteration = async (step, ctx_, state_, mode_) => {
        const repeats = !!(step.repeat && step.repeat.over);
        if (repeats || (step.forEach && step.forEach.overRef)) {
            // Same cancellation contract as dispatchStep, checked between
            // every iterated item (both the in-process signal and the
            // cross-process DB flag).
            const checkCancel = async () => {
                if (cancelSignal.aborted) throw new Error('Run cancelled');
                if (await isCancelRequested(run.id)) throw new Error('Run cancelled');
            };
            if (repeats) return execRepeatStep(step, ctx_, state_, mode_, runStepLeaf, checkCancel);
            return execForEachStep(step, ctx_, state_, mode_, runStepLeaf, checkCancel);
        }
        return runStepLeaf(step, ctx_, state_, mode_);
    };

    const dispatchStep = async (step, ctx_, state_, mode_) => {
        // Cancellation is checked between every step. We honour both the
        // in-process AbortSignal (fast path for local cancels) and the
        // cross-process DB flag (handles cancels issued against a different
        // runner pod).
        if (cancelSignal.aborted) throw new Error('Run cancelled');
        if (await isCancelRequested(run.id)) throw new Error('Run cancelled');

        const stepStartedAt = new Date().toISOString();
        // Defensive: a step missing `id` would crash recordRunStep
        // (step_id is NOT NULL). Synthesize one so we never write null
        // and so retries / errors still get a unique row.
        if (!step.id) {
            step.id = `unknown_${Math.random().toString(36).slice(2, 8)}`;
            log.warn(`[AutomationRunner] Step missing id; synthesized ${step.id}`);
        }

        // n8n-style data pinning. When a step has `pinnedOutput` we skip
        // the real handler and emit the pinned value verbatim — saves
        // upstream API/model calls during iterative debugging. Pinned
        // steps record as 'success' with source='pinned' so audit trails
        // distinguish synthetic outputs from live ones.
        if (step.pinnedOutput !== undefined && step.pinnedOutput !== null) {
            return {
                output: step.pinnedOutput,
                startedAt: stepStartedAt,
                inputSnapshot: snapshotInputs(step, state_),
                pinned: true,
                // 'pinned' status threads through runDag's recordedStatus
                // mapper so audit rows can distinguish synthetic from live
                // outputs without having to inspect the output JSON itself.
                skippedReason: 'pinned',
            };
        }

        // n8n-style "disable this node" toggle. Disabled steps pass
        // their resolved input through as `{ disabled: true, input }`
        // so downstream bindings don't crash on undefined, and never
        // call into integrations / models / notifications.
        if (step.disabled) {
            const passThrough = disabledPassThroughBranch(step);
            return {
                output: { disabled: true, ...(passThrough ? { branch: passThrough } : {}) },
                startedAt: stepStartedAt,
                inputSnapshot: snapshotInputs(step, state_),
                skippedReason: 'disabled',
            };
        }

        let result;
        try {
            result = await executeStepWithIteration(step, ctx_, state_, mode_);
            result.startedAt = stepStartedAt;
            // A fan-out (forEach) records its own per-item inputs; the
            // outer state has no loop.<itemVar>, so resolving here would
            // record every mapped field as empty.
            result.inputSnapshot = result.forEachInputSnapshot !== undefined ? result.forEachInputSnapshot : snapshotInputs(step, state_);
            delete result.forEachInputSnapshot;
            return result;
        } catch (err) {
            const inputForRecord = err.forEachInputSnapshot !== undefined ? err.forEachInputSnapshot : snapshotInputs(step, state_);
            const secretValues = secretValuesFor(state_);
            // Sub-step recording: namespace ids under the calling call_layer
            // step (ctx_.stepRecord.prefix) and suppress entirely inside
            // unrecorded loop bodies — mirrors the runDag record sites.
            const recStepId = (ctx_.stepRecord?.prefix || '') + step.id;
            const recParentStepId = ctx_.stepRecord?.parentStepId || null;
            const recSuppressed = !!ctx_.stepRecord?.suppress;
            // Pauses are not errors — record the step as awaiting_* so run
            // history shows the pause point and the resume path can find it.
            // The recorded OUTPUT is what the resumer reads: an approval shows
            // its prompt, a form page serves its rendered config to the
            // waiting visitor (it cannot be re-derived later — the run state
            // its templates referenced is gone by then).
            if (err instanceof ApprovalRequiredError || err instanceof FormInputRequiredError) {
                const isForm = err instanceof FormInputRequiredError;
                if (!recSuppressed) {
                    await automationStore.recordRunStep({
                        runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                        stepType: step.type, attempts: 1,
                        status: isForm ? 'awaiting_form' : 'awaiting_approval',
                        startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
                        input: inputForRecord,
                        output: isForm ? { form: err.form } : { prompt: err.prompt }, error: null,
                        secretValues,
                    });
                }
                throw err;
            }
            // Record the initial failed attempt up-front. Without this, an
            // initial fail followed by a successful retry would erase the
            // original error from the audit trail (runDag would overwrite
            // attempts=1 from 'error' to 'success'). Subsequent retries are
            // recorded as attempts=i+1 by the retry loop below.
            if (!recSuppressed) {
                await automationStore.recordRunStep({
                    runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                    stepType: step.type, attempts: 1,
                    status: 'error', startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
                    input: inputForRecord,
                    output: null, error: err.message,
                    errorClass: err.errorClass || classifyUnknownError(err),
                    // Handoff 5: the plain-language card (title, cause, the
                    // setting that fixes it, fix buttons) for the step drawer.
                    errorInfo: safeDescribeStepError(err, { step, inputs: inputForRecord }),
                    secretValues,
                });
            }
            // Attempt retry per step config. §WS2.5: a forEach that already did
            // per-item retry and threw all-failed (err.foreachHandled) must NOT
            // be retried whole here — that would re-run the entire fan-out.
            // A step's own retry wins; without one the routine's
            // runPolicy.retry.max is the default (handoff 5).
            const retry = stepRetryFor(step, runPolicy);
            if (retry && retry.max && retry.max > 0 && !err.foreachHandled) {
                for (let i = 1; i <= retry.max; i++) {
                    if (retry.backoffMs) await new Promise(r => setTimeout(r, retry.backoffMs));
                    const attemptStartedAt = new Date().toISOString();
                    try {
                        // Route retries through the same wrapper as the initial
                        // dispatch so per-item iteration (forEach) composes with
                        // retry. Approval throws on every call to pause; the
                        // enclosing executeAutomation handles the pause path
                        // before any retry kicks in (this block only fires for
                        // actual errors).
                        const retryResult = await executeStepWithIteration(step, ctx_, state_, mode_);
                        retryResult.startedAt = stepStartedAt;
                        retryResult.inputSnapshot = retryResult.forEachInputSnapshot !== undefined ? retryResult.forEachInputSnapshot : inputForRecord;
                        delete retryResult.forEachInputSnapshot;
                        // Tell runDag to record the final outcome at the
                        // correct `attempts` slot rather than overwriting
                        // attempts=1 (the initial-fail row above).
                        retryResult.attempt = i + 1;
                        retryResult.attemptStartedAt = attemptStartedAt;
                        return retryResult;
                    } catch (retryErr) {
                        // Record every retry attempt — not just the last. The
                        // audit trail otherwise has no rows for intermediate
                        // failures, hiding flaky-tool patterns from users.
                        if (!recSuppressed) {
                            await automationStore.recordRunStep({
                                runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                                stepType: step.type, attempts: i + 1,
                                status: 'error', startedAt: attemptStartedAt, finishedAt: new Date().toISOString(),
                                input: retryErr.forEachInputSnapshot !== undefined ? retryErr.forEachInputSnapshot : inputForRecord,
                                output: null, error: retryErr.message,
                                errorClass: retryErr.errorClass || classifyUnknownError(retryErr),
                                errorInfo: safeDescribeStepError(retryErr, { step, inputs: retryErr.forEachInputSnapshot !== undefined ? retryErr.forEachInputSnapshot : inputForRecord }),
                                // Retries may have pulled new secrets into state_
                                // via bridges — recompute rather than reuse.
                                secretValues: secretValuesFor(state_),
                            });
                        }
                    }
                }
            }
            // §WS4: retries are structural — they all ran above, so the
            // error escaping here IS final. Stamp which attempts slot holds
            // the last recorded 'error' row so runDag's on_error catch can
            // flip exactly that row to 'handled_error' (PK upsert) instead
            // of fabricating a duplicate attempts=1 row.
            err.finalAttempt = (retry && retry.max > 0 && !err.foreachHandled) ? retry.max + 1 : 1;
            throw err;
        }
    };

    let runResult;
    let runErrorObj = null;
    let runErrorMsg = null;
    let runStatus = 'success';
    let wasCancelled = false;

    // runPolicy.maxDurationMin (handoff 5) sets the budget when the routine
    // has one; else the row's run_timeout_ms, else the platform default.
    // Waiting (Wait steps, approvals, form pages) still does not count: the
    // deadline below is extended for those.
    const effectiveTimeoutMs = clampRunTimeout({ runTimeoutMs: runTimeoutMsFor(runPolicy) ?? automation.runTimeoutMs });
    let timeoutTimer = null;
    // Re-armable deadline (A8): Wait steps EXTEND it by their planned sleep,
    // so "Wait up to 24 hours" (the documented contract, validate.js 1..86400)
    // stops guaranteeing a "Run hard timeout" the moment the wait exceeds the
    // ~5-minute run budget. Sleep time no longer counts against the budget;
    // actual WORK time still does. Cumulative extension is capped at 24h.
    let deadlineAt = Date.now() + effectiveTimeoutMs;
    let extendedTotalMs = 0;
    ctx.extendRunDeadline = (ms) => {
        const grant = Math.max(0, Math.min(Number(ms) || 0, 86_400_000 - extendedTotalMs));
        extendedTotalMs += grant;
        deadlineAt += grant;
        // The step that just told us it will be alive far longer than its
        // budget is exactly the step whose sleep would otherwise outlive the
        // reaper's window on the automations row — so refresh that marker here
        // too, not only on the next 15s heartbeat tick (W5-16).
        touchRunMarker();
    };
    // Cancellable-sleep hook for execWait: chunked sleeps poll this signal so
    // a cancel lands within seconds instead of after the full wait.
    ctx.cancelSignal = cancelSignal;
    // §WS2.1 — the DAG promise. We keep a handle so that on a timeout/cancel we
    // can abort the controller and AWAIT runDag's unwind before finalizing —
    // otherwise Promise.race only stops *waiting* for runDag; runDag itself keeps
    // dispatching steps (real side effects + recordRunStep writes) against a run
    // row we've already marked terminal. `dagDone` lets the finally skip the
    // abort on the normal success/approval path (runDag already settled there).
    let dagDone = false;
    const dagPromise = runDag(automation.definition || {}, ctx, runState, effectiveMode, dispatchStep, { recordSteps: true, skipUntilStepId, onlyStepId, fromStepId, untilStepId, rootStepId, replayGaps });
    dagPromise.then(() => { dagDone = true; }, () => { dagDone = true; });
    const dagSettled = dagPromise.catch(() => {}); // swallow the late rejection once the race has already taken it
    const guard = new Promise((_, reject) => {
        const arm = () => {
            const ms = deadlineAt - Date.now();
            if (ms <= 0) return reject(new Error('Run hard timeout'));
            // Short re-arm interval so a deadline extension granted mid-wait
            // is picked up without bookkeeping on the extension side.
            timeoutTimer = setTimeout(arm, Math.min(ms, 30_000));
            if (timeoutTimer.unref) timeoutTimer.unref();
        };
        arm();
    });
    guard.catch(() => {}); // never an unhandled rejection
    // Abort signal also rejects the race, so the cancel endpoint can stop
    // the run even when the runDag promise is awaiting a long upstream call.
    const cancelGuard = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('Run cancelled'));
        if (cancelSignal.aborted) onAbort();
        else cancelSignal.addEventListener('abort', onAbort, { once: true });
    });
    cancelGuard.catch(() => {}); // finally may abort() and reject this with no live race handler

    try {
        runResult = await Promise.race([dagPromise, guard, cancelGuard]);
    } catch (e) {
        runErrorObj = e;
        runErrorMsg = e.message || String(e);
        wasCancelled = cancelSignal.aborted || e.message === 'Run cancelled';
        if (e instanceof ApprovalRequiredError) {
            runStatus = 'awaiting_approval';
        } else if (e instanceof FormInputRequiredError) {
            // Distinct from awaiting_approval on purpose: the approvals UI must
            // not offer an Approve/Reject bar for a visitor's half-filled form.
            runStatus = 'awaiting_form';
        } else if (wasCancelled) {
            runStatus = 'cancelled';
        } else {
            runStatus = 'error';
        }
    } finally {
        // §WS2.1 — if the race ended via timeout or cancel while runDag is still
        // in flight, abort the controller so dispatchStep's between-step check
        // short-circuits it, then wait for it to unwind so no further step runs
        // against this finalized run. On success/approval runDag already settled
        // (dagDone), so we must NOT abort — that would falsely trip the §WS2.3
        // cancel re-check below.
        if (!dagDone) {
            try { cancelController.abort(); } catch (_) { /* noop */ }
            await dagSettled;
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearRunCancellation(run.id);
    }

    // §WS2.3 — a cancel requested while the FINAL step was executing is otherwise
    // lost: runDag returns normally (cancel is only checked at the START of each
    // step) and we'd record 'success'. Re-check the cancel authority — the
    // in-process signal OR the cross-pod cancel_requested DB flag — and downgrade
    // to 'cancelled' so the success notification + resetAttempts are skipped.
    if (runStatus === 'success' && (cancelSignal.aborted || await isCancelRequested(run.id).catch(() => false))) {
        runStatus = 'cancelled';
        wasCancelled = true;
        runErrorMsg = runErrorMsg || 'Run cancelled';
    }

    // Sanitized error fields for any persisted message visible to users.
    // The raw error stays in the run row's `error` column for diagnostics
    // (server-only); user-facing notifications get the redacted line.
    const sanitized = runErrorObj ? sanitizeError(runErrorObj) : null;
    const userSafeError = sanitized
        ? (sanitized.error_first_line || `Failed (${sanitized.error_code})`)
        : runErrorMsg;

    // Stable, queryable class for the run (lights up the run-facets dashboard).
    const runErrorClass = (runStatus === 'error' && runErrorObj)
        ? (runErrorObj.errorClass || classifyUnknownError(runErrorObj))
        : null;
    // Nextcloud errors already embed "<cause> — <remediation>" in their text;
    // for other errors append a generic remediation so we never double it.
    const runRemediation = (runStatus === 'error' && !runErrorObj?.ncError && runErrorClass)
        ? remediationFor(runErrorClass)
        : null;

    const finishedAt = new Date().toISOString();
    // §WS4: failures absorbed by on_error branches. The run still reports
    // 'success', but the summary + handled_error_count make the recoveries
    // visible in the run history.
    const handledErrorCount = Array.isArray(runState._handledErrors) ? runState._handledErrors.length : 0;
    // Everything the run warned about, for the run view (runWarnings.js).
    const runWarnings = recordedRunWarnings(runState._templateWarnings);
    const memoStats = (() => {
        try { return ctx._toolMemo?.stats?.() || {}; } catch (_) { return {}; }
    })();
    const memoHits = memoStats.hits || 0;
    const durableHits = memoStats.durableHits || 0;
    const memoRefused = memoStats.refused || 0;
    // Counters only, never a key or a value (toolMemo.stats() cannot return
    // either). Reuse that is invisible is reuse nobody can audit: this is the
    // one place a person looking at a finished run can see that an answer was
    // used again instead of being asked for.
    //
    // The three are named separately because they are different facts: one
    // says "we asked once instead of two hundred times", the next says "we did
    // not contact this app at all" — the only one that explains a run holding
    // yesterday's data — and the last says the reuse was asked for and did
    // nothing, which must never be indistinguishable from never asking.
    const reuseNotes = [];
    if (memoHits > 0) reuseNotes.push(`${memoHits} look-up(s) answered from earlier in the run`);
    if (durableHits > 0) reuseNotes.push(`${durableHits} answered from an earlier run`);
    if (memoRefused > 0) reuseNotes.push(`${memoRefused} answer(s) too big to reuse, so they were asked again`);
    // Appended to every TERMINAL summary — success and failure alike. The
    // pause lines below stay clean on purpose: a paused run is not finished,
    // and "Waiting for approval." is the sentence the run list reads.
    const withReuse = (text) => (reuseNotes.length ? `${text} — ${reuseNotes.join(', ')}` : text);
    const summary = (() => {
        if (firstRunNeedsConfirm) return 'Awaiting first-run confirmation. Review the dry-run output and approve to run live.';
        // A pause is not a failure. Without this, a run waiting on a person
        // reads as "Failed: Approval required at step s3" in the run list.
        if (runStatus === 'awaiting_approval') return 'Waiting for approval.';
        if (runStatus === 'awaiting_form') return 'Waiting for the visitor to fill in the next form page.';
        // The reuse notes ride on the FAILURE line too. They used to live only
        // in the success path, so a run that fetched from an earlier run and
        // then blew up at step 9 reported neither counter — deleting the
        // evidence from exactly the runs someone opens asking "why did this
        // act on yesterday's data and then fail?".
        if (runErrorMsg) return withReuse(runRemediation ? `Failed: ${userSafeError}. ${runRemediation}` : `Failed: ${userSafeError}`);
        const base = summariseDefinition(automation.definition || {}).summary;
        const withErrors = handledErrorCount > 0
            ? `${base} — ${handledErrorCount} step error(s) handled by error branch`
            : base;
        return withReuse(withErrors);
    })();

    // For awaiting_approval, persist the approval token + the step id so
    // the resume endpoint can validate and continue.
    let approvalToken = null;
    if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
        approvalToken = crypto.randomBytes(24).toString('hex');
    }

    // Persist the token vault before the run row goes terminal. This is the
    // hand-off point: an approval pause resumes in another process, and a
    // retry-from-step seeds its vault from this run — both need the map on disk.
    await tokenVault.flush();

    await automationStore.updateRun(run.id, {
        status: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
        finishedAt,
        durationMs: Date.now() - startedAt,
        error: runErrorMsg,
        ...(runErrorClass ? { errorClass: runErrorClass } : {}),
        summary,
        ...(handledErrorCount > 0 ? { handledErrorCount } : {}),
        ...(runWarnings.length ? { warnings: runWarnings } : {}),
        ...(runStatus === 'awaiting_approval' || runStatus === 'awaiting_form'
            ? {
                awaitingStepId: runErrorObj?.stepId || null,
                // Only approvals mint a token; a form's credential is the
                // session id the visitor's browser already holds.
                approvalToken,
                // §WS2.2 — persist the deadline so the approve endpoint's 410
                // guard and the reaper's expiry pass actually fire. A form page
                // always has one: someone is sitting in front of it.
                awaitingStepExpiresAt: runErrorObj?.expiresAt || null,
            }
            : {}),
    });

    // The durable approval record — created only after updateRun has the
    // awaiting_* columns on disk, so the row never points at a run that could
    // still finalize differently. Best-effort by contract: the run's own
    // awaiting state is the engine's truth, and the list path backfills rows,
    // so a failure here degrades to "no rich card yet", never a stuck run.
    let approvalRow = null;
    if (!firstRunNeedsConfirm && runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
        const { createApprovalOnPause } = require('./approvalLifecycle');
        approvalRow = await createApprovalOnPause({ automation, run, err: runErrorObj });
    }

    // Stream the terminal state so the executions list + open execution flip
    // from running → final without a refresh.
    const finalStatus = firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus;

    // Handoff 5: the run's one-sentence outcome ({ code, params, text }), read
    // off the rows it recorded. After the approval row exists, so a paused run
    // can say whom it waits on; before onRunFinished and the lifecycle event,
    // so whoever reacts to those reads a complete row.
    await writeRunOutcome({
        runId: run.id,
        status: finalStatus,
        definition: automation.definition,
        error: runErrorObj ? {
            message: runErrorMsg,
            errorClass: runErrorClass,
            ncCode: runErrorObj.ncError?.code || null,
        } : null,
        awaitingStepId: (runStatus === 'awaiting_approval' || runStatus === 'awaiting_form') ? (runErrorObj?.stepId || null) : null,
        approval: approvalRow,
        ownerId: automation.userId,
        handledErrorCount,
    });

    // The run row is TERMINAL (or paused) on disk now — the second moment a
    // caller can act on, mirroring onRunCreated. The public form uses it to
    // stamp "completed" on the answers row once the journey has no more pages
    // to ask. Best-effort by the same contract: bookkeeping never takes a
    // run down.
    if (typeof onRunFinished === 'function') {
        try { await onRunFinished(run, { status: finalStatus }); } catch (e) {
            log.warn(`[automationRunner] onRunFinished hook failed for run ${run.id}: ${e.message}`);
        }
    }
    if (runStatus === 'error') {
        emitLifecycle('run.failed', { status: 'error', errorClass: runErrorClass, error: userSafeError, durationMs: Date.now() - startedAt });
    } else {
        emitLifecycle('run.finished', { status: finalStatus, durationMs: Date.now() - startedAt, handledErrorCount });
    }

    // Release the running marker + update the automation's last-run state — but
    // ONLY for runs that own the marker (live runs). §WS2.4: a dry-run is a
    // preview that never marked the row running, so it must not release (which
    // would clear a concurrent live run's marker) nor overwrite lastStatus/
    // lastRunAt with preview results. Without releasing, a live row stays
    // `running` forever on a crash — the reaper still catches that; releasing
    // here is the fast path.
    if (ownsMarker) {
        try {
            await automationStore.updateAutomation(automation.id, {
                lastStatus: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
                lastRunAt: finishedAt,
            }, automation.userId);
            // A run entered through a SECONDARY schedule advances ITS OWN row
            // (automation_schedules), never the primary's columns — and does so
            // BEFORE the marker is released, so the row cannot be re-claimed in
            // the gap. A cron with no future match clears that one schedule and
            // says so; the routine's other entry points keep working.
            if (schedule?.id && typeof automationStore.advanceSchedule === 'function') {
                let next = null;
                // schedule.skipHolidays (handoff 5) is read from the definition this run executed.
                try { next = holidays.nextScheduledRunAt(schedule.cron, schedule.tz || 'Europe/Amsterdam', Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, rootStepId) }); } catch (_) { next = null; }
                await automationStore.advanceSchedule(schedule.id, { nextRunAt: next, lastRunAt: finishedAt, lastStatus: runStatus });
                if (!next) {
                    log.warn(`[AutomationRunner] Cron "${schedule.cron}" (${schedule.tz}) for ${automation.id} (trigger ${rootStepId || '?'}) has no future run — that schedule is now idle.`);
                    try {
                        await notifyRunEvent(automation, 'onError', {
                            code: 'automation.notify.schedule_idle',
                            title: `⏸️ A schedule went idle: ${automation.title}`,
                            message: `The extra schedule "${schedule.cron}" has no upcoming run time, so it will not fire again. Edit that trigger and save to re-arm it. The routine's other triggers are unaffected.`,
                        });
                    } catch (_) { /* notification failure is non-fatal */ }
                }
            }
            await automationStore.releaseAutomation(automation.id);
            if (runStatus === 'success') {
                await automationStore.resetAttempts(automation.id);
            }
        } catch (e) {
            log.warn(`[AutomationRunner] release/update failed for ${automation.id}: ${e.message}`);
        }
    }

    // Notifications — error path uses the sanitized message so we never
    // leak upstream API payloads or bearer tokens echoed in error bodies.
    // Each event consults the routine's notification policy (see
    // runNotifications.notifyRunEvent) so success-path noise can be silenced
    // by the user without losing failure / approval alerts.
    try {
        if (firstRunNeedsConfirm) {
            await notifyRunEvent(automation, 'onApproval', {
                title: `Confirm first real run of "${automation.title}"`,
                message: `Your automation produced a dry-run preview. Approve to run it live.`,
                link: require('../../utils/appPaths').automationRunPath(automation.id, run.id),
                runId: run.id,
                code: 'automation.notify.first_run_confirm',
            });
        } else if (runStatus === 'success' && triggerKind !== 'dry_run' && effectiveMode === 'live' && !testRun) {
            // A test run is watched by whoever started it: no notification.
            await notifyRunEvent(automation, 'onSuccess', {
                title: `🤖 ${automation.title}`,
                message: summary,
                runId: run.id,
            });
        } else if (runStatus === 'error' && !testRun) {
            await notifyRunEvent(automation, 'onError', {
                title: `⚠️ Automation failed: ${automation.title}`,
                message: userSafeError || 'Unknown error',
                runId: run.id,
            });
        } else if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
            // With an assignee, the REQUEST goes to them — the owner sees it
            // in the Approvals list and is notified of the outcome instead.
            // Without a row (creation failed), fall back to the run deep-link
            // the Executions view already understands.
            //
            // The policy decides the rest (runNotifications.notifyRunEvent):
            // the bell per approver, e-mail, and on Talk ONE reactable card in
            // the conversation, not one per person who can see it. Every
            // attempt lands in automation_notification_events; the Talk card
            // also in automation_approval_deliveries, which is what routes a
            // 👍 back to this row.
            const { approvalNotificationTargets } = require('./approvalLifecycle');
            const targets = await approvalNotificationTargets(approvalRow, automation);
            const link = targets.link
                || require('../../utils/appPaths').automationRunStepPath(automation.id, run.id, runErrorObj.stepId);
            await notifyRunEvent(automation, 'onApproval', {
                title: `🛂 Approval needed: ${automation.title}`,
                message: `${runErrorObj.prompt || 'Approval requested'} — open it to approve or reject.`,
                link,
                runId: run.id,
                code: 'automation.notify.approval_needed',
                approverIds: targets.userIds,
                approval: approvalRow || null,
            });
        }
        // No notification for cancelled runs — the user initiated the cancel
        // so they already know. The run history shows the status.
    } catch (_) { /* notification failure is non-fatal */ }

    // Schedule advancement (unless this was a manual run or first-run confirm).
    // Only the PRIMARY schedule lives on the automation row; a run that came in
    // through a secondary schedule (`schedule` set, advanced above) must not
    // move the primary's next_run_at.
    if (automation.triggerType === 'schedule'
        && !firstRunNeedsConfirm
        && !schedule
        && triggerKind !== 'manual'
        && triggerKind !== 'dry_run'
        && automation.scheduleCron) {
        try {
            const next = holidays.nextScheduledRunAt(automation.scheduleCron, automation.scheduleTz, Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, null) });
            if (next) {
                await automationStore.updateAutomation(automation.id, { nextRunAt: next }, automation.userId);
            } else {
                // cron.nextRunAt returned null → this cron has no reachable
                // future match (e.g. "31 2 *" — Feb 31). Leaving next_run_at
                // at its stale past value would re-qualify the row for
                // claimDueAutomations EVERY tick — an infinite ~60s refire
                // loop. Clear next_run_at (so it can't be re-claimed) and
                // deactivate the schedule, then tell the user why.
                log.warn(`[AutomationRunner] Cron "${automation.scheduleCron}" (${automation.scheduleTz}) for ${automation.id} has no future run — disabling schedule.`);
                await automationStore.updateAutomation(automation.id, { nextRunAt: null, isActive: false }, automation.userId);
                try {
                    await notifyRunEvent(automation, 'onError', {
                        code: 'automation.notify.schedule_disabled',
                        title: `⏸️ Schedule disabled: ${automation.title}`,
                        message: `The schedule "${automation.scheduleCron}" has no upcoming run time, so the automation was paused. Edit the schedule and re-activate it.`,
                    });
                } catch (_) { /* notification failure is non-fatal */ }
            }
        } catch (e) {
            log.warn(`[AutomationRunner] Cron advance failed for ${automation.id}: ${e.message}`);
        }
    }

    return withLastOutput(await automationStore.getRun(run.id), runResult?.lastOutput ?? null);
}

/**
 * Write a run's outcome sentence (automation/runOutcome.js). Best-effort by
 * contract: a sentence that cannot be built or stored never fails the run.
 */
async function writeRunOutcome(input) {
    try {
        const { resolveRunOutcome, storeOutcomeDeps } = require('../../automation/runOutcome');
        const outcome = await resolveRunOutcome(input, storeOutcomeDeps(automationStore));
        await automationStore.updateRun(input.runId, { outcome });
    } catch (e) {
        log.warn(`[AutomationRunner] could not write the outcome of run ${input.runId}: ${e.message}`);
    }
}

/**
 * Attach the run's final step output to the run row `executeAutomation`
 * returns.
 *
 * `lastOutput` is NOT a column — `rowToRun` (stores/automationStore/rowMappers.js)
 * never had it, and only `runDag` produces it (automationRunner/engine.js). But
 * three callers return a routine's result to an AI agent and read it straight
 * off this object, so all three silently answered `null` for every call:
 *   - runStepAsTool (below) — a Reusable Step used as a chat tool
 *   - automation/agentCallableTools.js — an agent-callable routine
 *   - routes/automation/webhooksAndRunOps.js — POST /:id/agent-invoke
 * The agent ran the routine and was told nothing came back.
 *
 * Attached in memory, never persisted: run rows stay the audit trail, and the
 * per-step outputs are already recorded (automation_run_steps). Every exit path
 * sets the key — `null` on the early ones — so no caller has to test for it.
 */
function withLastOutput(runRow, lastOutput) {
    return runRow ? { ...runRow, lastOutput: lastOutput ?? null } : runRow;
}

module.exports = { runOrgFor, disabledPassThroughBranch, resolveEnteredTrigger, resolveTriggerPayload, buildTriggerState, acquireRunMarker, executeAutomation };
