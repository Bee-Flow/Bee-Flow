// @typecheck
/**
 * The run's execution context and its first gates (moved verbatim out of
 * execution.js's executeAutomation): the `ctx` every step handler receives,
 * the recorded resumption boundary of a resumed leg, and the Privacy Shield
 * scan of the trigger payload that can stop a run before step 1.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const { createToolMemo } = require('./toolMemo');
const log = require('../../telemetry/log');
const { writeRunOutcome, withLastOutput } = require('./runFinalize');
const { bestEffort } = require('../../utils/bestEffort');

/** The `ctx` of one run (container steps shallow-copy it). */
function buildRunContext({
    automation, runOrgId, isResume, session, run, tokenVault, runPolicy, stepRecord,
    effectiveMode, onlyStepId, fromStepId, emitLifecycle, enteredTrigger,
    identity: { runUserGroupIds, runUserOrgRole, runUserHomeOrgId, runIdentityError },
}) {
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
        // Every mapping that found nothing in this run, across branches, loop
        // bodies and layers (shared by reference with every ctx copy, so it is
        // created here, never lazily): the summary says how many and which
        // (bindingMisses.js).
        _bindingMisses: [],
        // Every Loop / per-item step an iteration cap cut short (truncations.js);
        // shared by reference like _bindingMisses, so it is created here.
        _truncations: [],
        // Paths a dry run's simulated side-effect steps would have produced
        // (simulatedPaths.js). Shared by reference with every ctx copy, so it is
        // created here, never lazily: a write inside a loop body or parallel
        // branch must be visible to a read after it.
        _simulatedPaths: new Set(),
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
        // The automation's run policy (runPolicy.js). runDag reads
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
    return ctx;
}

/** Record the step a resumed leg continues from (live runs only). */
async function recordResumeBoundary(deps, { skipUntilStepId, replayState, effectiveMode, automation, run, runState }) {
    const { automationStore } = deps;
    const { secretValuesFor } = deps.engine;
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
}

/**
 * The Privacy Shield gate on the trigger payload.
 *
 * @returns {Promise<{ blocked: boolean, row: object|null }>} `blocked` with the
 *   failed run row (lastOutput attached) when a `block` policy stopped the run.
 */
async function guardTriggerPayload(deps, { triggerPayload, triggerKind, ctx, runState, effectiveMode, run, heartbeatTimer, startedAt, automation, ownsMarker, emitLifecycle }) {
    const { safety, automationStore, clearRunCancellation } = deps;
    // ── Safety: scan the trigger payload ──────────────────────────────────
    // The raw webhook body / event payload used to land in runState completely
    // unseen — it is the one input to an automation nobody in this org typed, and
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
                    error: /** @type {Error} */ (e).message, errorClass: 'guardrail_blocked',
                    summary: `Failed: ${/** @type {Error} */ (e).message}`,
                }).catch((e) => bestEffort('core/automationRunner/runContext:guardTriggerPayload', e));
                await writeRunOutcome(deps, {
                    runId: run.id, status: 'error', definition: automation.definition,
                    error: { message: /** @type {Error} */ (e).message, errorClass: 'guardrail_blocked' },
                });
                if (ownsMarker) {
                    await automationStore.updateAutomation(automation.id, {
                        lastStatus: 'error', lastRunAt: new Date().toISOString(),
                    }, automation.userId).catch((e) => bestEffort('core/automationRunner/runContext:guardTriggerPayload#2', e));
                    await automationStore.releaseAutomation(automation.id).catch((e) => bestEffort('core/automationRunner/runContext:guardTriggerPayload#3', e));
                }
                emitLifecycle('run.failed', { status: 'error', errorClass: 'guardrail_blocked', error: /** @type {Error} */ (e).message, durationMs: Date.now() - startedAt });
                return { blocked: true, row: withLastOutput(await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'error' })), null) };
            }
            throw e;
        }
    }
    return { blocked: false, row: null };
}

module.exports = { buildRunContext, recordResumeBoundary, guardTriggerPayload };

/**
 * @typedef {import('./runSetup').RunAutomation} RunAutomation
 * @typedef {import('./runSetup').RunRow} RunRow
 * @typedef {import('./runSetup').RunDeps} RunDeps
 * @typedef {Awaited<ReturnType<typeof import('./runSetup').buildRunState>>} RunState
 */
