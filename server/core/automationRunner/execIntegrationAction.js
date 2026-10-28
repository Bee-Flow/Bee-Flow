// @typecheck
/**
 * The integration-action step executor (moved verbatim out of execAi.js):
 * the safety gates, the permission re-check, connection lending, the run
 * memo / durable cross-run cache (./integrationActionMemo.js) and the
 * dispatch itself. execAi.js re-exports it, so importers keep requiring
 * './execAi'.
 *
 * `deps` (the last argument) carries what sits in the server's large import
 * cycle (safety, the ./shared result helpers, envFlagOn, and lazy getters
 * for integrationCachePolicy, toolDispatcher, integrationTools and
 * connectionResolution). execAi.js requires those and hands them over, so
 * this module and ./integrationActionGates stay out of the cycle
 * (lint:scc-ratchet) and nothing loads earlier than before.
 */

const { resolveInputs } = require('../automationModel/bind');
const { failOnBlankInputs } = require('./blankInputs');
const { captureBindingMisses } = require('../automationModel/bindCapture');
const { isSideEffect } = require('../automationModel/sideEffectMap');
// What this module needs from automation/ (a feature) comes through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');

/** automation/outputSchemas' sample output for a tool, for dry runs. */
const synthesizeDryRunOutput = (toolName, args) => runnerPort('outputSchemas').synthesizeDryRunOutput(toolName, args);
const { runWithProbe, markLocal } = require('../http/outboundProbe');
const log = require('../../telemetry/log');
const { assertStepToolPermitted, resolveLendingIdentity } = require('./integrationActionGates');
const { toolIdentity } = require('./toolIdentity');
const { recordSimulatedWrite, isUnderSimulatedPath, isNotFoundError } = require('./simulatedPaths');
const { planReuse, readReuse, rememberAnswer } = require('./integrationActionMemo');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * ── Safety: scan resolved inputs (toolInput scope) before anything leaves ──
 * the platform. On a `block` action this throws GuardrailBlockError, which
 * flows through dispatchStep's catch → on_error edge or a fail-loud run.
 */
async function guardInputs(step, ctx, mode, inputs, safety) {
    const policy = await safety.resolveAutomationPolicy(ctx);
    const auditBase = safety.buildAuditBase(ctx, step);
    try {
        return { policy, auditBase, guardedIn: await safety.guardToolInput(inputs, policy, auditBase, mode, ctx) };
    } catch (err) {
        // A blocked call still belongs in the egress ledger: "we stopped this
        // from leaving" is exactly the evidence the Art-44 record needs, and
        // without it a blocked tool call was invisible there.
        if (err && err.guardrailBlocked) {
            await safety.logEgress({
                toolName: step.tool, toolArgs: {}, blocked: true, error: err,
                policy, auditBase, mode, durationMs: 0,
            });
        }
        throw err;
    }
}

/** A dry run that must not dispatch: the synthesized answer, or null to go on. */
function dryRunWithoutDispatch(step, ctx, runState, { mode, sideEffect, guardedIn, inputs, stepInputsSynthetic }) {
    if (mode !== 'dry_run') return null;
    if (sideEffect) {
        // No real dispatch in a side-effect dry-run, so nothing egresses — but
        // still surface a "would block" annotation for the builder preview.
        recordSimulatedWrite(ctx, step.tool, inputs);
        const out = synthesizeDryRunOutput(step.tool, inputs);
        if (guardedIn.wouldBlock) out._guardrailWouldBlock = guardedIn.categories;
        return { output: out, dryRunSynthesised: true };
    }
    if (guardedIn.wouldBlock) {
        // Read-only tool in a dry-run: a `block` action returns the payload
        // UNTRANSFORMED, and this must not fall straight through to a live
        // dispatch — the one mode that must never leak would send the raw value to
        // a third party. Synthesize instead, and keep the preview annotation.
        const out = synthesizeDryRunOutput(step.tool, inputs);
        out._guardrailWouldBlock = guardedIn.categories;
        return { output: out, dryRunSynthesised: true, dryRunFallback: 'guardrail_block' };
    }
    if (stepInputsSynthetic(step, runState, ctx)) {
        // Read tool, but its inputs derive from SYNTHESIZED upstream data
        // (sample fallback / simulated side-effect / synthetic trigger).
        // Dispatching fake ids live guarantees a provider error per call —
        // synthesize directly instead of hammering the API.
        const out = synthesizeDryRunOutput(step.tool, inputs);
        return { output: out, dryRunSynthesised: true, dryRunFallback: 'synthetic_input' };
    }
    return null;
}

/**
 * The live dispatch, wrapped in runWithProbe so the global fetch shim captures
 * the destination IP for the egress row. markLocal keeps on-host integrations
 * honest. The inner fn never THROWS through runWithProbe — a throw would
 * discard the probe, and with it the audit row for a failed call whose bytes
 * had already left the box.
 */
function dispatchTool(step, ctx, mode, { executeTool, inputs, identity, resolveIntegration }) {
    const { stepUserId, stepOrgId, stepSession, lentConnection } = identity;
    return runWithProbe(async () => {
        const meta = resolveIntegration(step.tool, inputs, { nextcloudUrl: ctx.nextcloudUrl });
        if (meta && meta.isLocal) markLocal(meta.label || meta.integration);
        try {
            return {
                ok: true,
                value: await executeTool(step.tool, inputs, {
                    userId: stepUserId,
                    // MCP dispatch reads the caller id from userAuth ONLY
                    // (toolExecution.js: `userAuth?.userId || userAuth?.user_id`),
                    // never from context.userId. Without this every mcp_*
                    // step — and every declaration-driven trigger poll that
                    // calls one — dies on "User ID required for MCP tool
                    // calls" before it reaches the server.
                    userAuth: { ...(ctx.userAuth || {}), userId: stepUserId },
                    session: stepSession,
                    orgId: stepOrgId,
                    userGroupIds: toolIdentity(ctx).userGroupIds,
                    connectionsCallerUserId: ctx.callerOnly ? ctx.callerOnly.userId : null,
                    // The automation this step belongs to — what lets a
                    // self-scoped tool (automation_*) act on its own automation
                    // and nothing else.
                    automationId: ctx.automationId || null,
                    userOrgIds: ctx.userOrgIds || [],
                    // The run, for tools that push a file a document step
                    // kept (sourceHandle kind generated_file).
                    runScope: ctx.runId ? { runId: ctx.runId, rootRunId: ctx.rootRunId || ctx.runId } : null,
                    // Tell email/ticket-style tools that there is NO user UI here to
                    // approve a draft — emit the side effect immediately. Only set
                    // for live mode (dry_run is handled above with synthesized output).
                    autoSend: mode === 'live',
                    ...(lentConnection ? { lentConnection } : {}),
                }),
            };
        } catch (err) {
            return { ok: false, error: err };
        }
    });
}

/**
 * A failed dispatch. A REAL dispatch happened in both modes (dry-run
 * dispatches read-only tools live) — the failed call's bytes already left the
 * box, so both modes get a status='error' row. Dry-run rows carry
 * is_dry_run=true, same as the success path.
 *
 * A live run throws. A dry run throws too, EXCEPT for the two cases checkResult
 * also lets through, each flagged on the step so it is never mistaken for a
 * real answer: an error about the ENVIRONMENT (not connected, unreachable,
 * auth lapsed: 'not_connected') and a not-found on a path only a simulated
 * step wrote ('simulated_upstream'). A timeout, a rejected id or a bad column
 * must not be swapped for the sample too, or a read that cannot work shows a
 * green step and the forEach behind it iterates over nothing.
 */
async function dispatchFailed(step, ctx, mode, { err, inputs, resolvedInputs, probe, policy, auditBase, t0, deps }) {
    await deps.safety.logEgress({
        toolName: step.tool, toolArgs: inputs, error: err, probe, policy, auditBase, mode,
        durationMs: Date.now() - t0,
    });
    const message = String(err?.message ?? err);
    /** @type {string | null} */
    let fallback = null;
    if (mode === 'dry_run') {
        if (deps.isEnvironmentToolError(message)) fallback = 'not_connected';
        else if (isNotFoundError(step.tool, message) && isUnderSimulatedPath(ctx, resolvedInputs && resolvedInputs.path)) fallback = 'simulated_upstream';
    }
    if (!fallback) throw deps.enrichNextcloudError(step.tool, err);
    // Dedupe the warning per (tool, message) — a fan-out would spam
    // dozens of identical lines per dry-run.
    const logKey = `${step.tool}:${message}`;
    ctx._dryRunFallbackLogged = ctx._dryRunFallbackLogged || new Set();
    if (!ctx._dryRunFallbackLogged.has(logKey)) {
        ctx._dryRunFallbackLogged.add(logKey);
        log.warn(`[AutomationRunner] dry-run: live ${step.tool} failed (${fallback}), using sample (${message})`);
    }
    return { output: synthesizeDryRunOutput(step.tool, inputs), dryRunSynthesised: true, dryRunFallback: fallback };
}

/**
 * The answer, checked: an empty dry-run read and an environment error in a dry
 * run fall back to the sample; a soft `{ error }` fails the step. Returns a
 * step result to hand back as-is, or null when `result` stands.
 */
function checkResult(step, ctx, mode, { result, inputs, resolvedInputs, deps }) {
    // Empty-result fallback: a live read-only call that returned no rows
    // teaches the AI nothing about field shapes. In dry-run, swap in the
    // sample so downstream binding decisions are made against realistic
    // data. (Live mode keeps the empty result — the user wanted truth.)
    if (mode === 'dry_run' && deps.isEmptyToolResult(result)) {
        return { output: synthesizeDryRunOutput(step.tool, inputs), dryRunSynthesised: true, dryRunFallback: 'live_empty' };
    }
    // A tool call that returned a soft `{ error }` object must fail the step —
    // recording it as success masks misconfigured steps (they show green while
    // doing nothing). Routes through the same catch as a thrown error, so
    // on_error edges / retries still apply.
    //
    // This holds in a DRY RUN too, with one exception. The exception is what
    // the carve-out here was originally for: an error about the ENVIRONMENT (no
    // credentials, app not connected, endpoint unreachable) still falls back to
    // a sample, so the builder can plan an automation for an app this workspace has
    // not connected yet. An error about THIS STEP does not: "path is required"
    // reported as success is how an automation with `loop.f.path` refs and no
    // forEach at all passed its dry run and got finalised (2026-09-12).
    if (!deps.isToolErrorResult(result)) return null;
    if (mode === 'dry_run' && deps.isEnvironmentToolError(result.error)) {
        return { output: synthesizeDryRunOutput(step.tool, inputs), dryRunSynthesised: true, dryRunFallback: 'not_connected' };
    }
    // A read of a path only a SIMULATED step would have produced (a file the
    // dry run "uploaded", a folder it "created") cannot exist yet: sample it.
    // A path no earlier step touched is a real typo and still fails.
    if (mode === 'dry_run' && isNotFoundError(step.tool, result.error) && isUnderSimulatedPath(ctx, resolvedInputs && resolvedInputs.path)) {
        return { output: synthesizeDryRunOutput(step.tool, inputs), dryRunSynthesised: true, dryRunFallback: 'simulated_upstream' };
    }
    /** @type {import('./runnerError.types').RunnerError} */
    const err = new Error(`${step.tool} failed: ${String(result.error)}`);
    err.toolError = true;
    throw deps.enrichNextcloudError(step.tool, err, String(result.error));
}

async function execIntegrationAction(step, ctx, runState, mode, deps) {
    // Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
    // the agent/direct-chat pipeline so automations stop bypassing those controls.
    const { safety, stepInputsSynthetic } = deps;
    // Tool arguments are data, not prose: a list in a `{{…}}` stays JSON.
    const sideEffect = isSideEffect(step.tool);
    const resolved = captureBindingMisses(() => resolveInputs(step.inputs || {}, runState, { allowSecrets: true, listAs: 'json' }));
    let inputs = resolved.value;
    if (mode !== 'dry_run' && sideEffect) failOnBlankInputs(step, resolved.misses);
    const { policy, auditBase, guardedIn } = await guardInputs(step, ctx, mode, inputs, safety);
    const { resolveIntegration } = require('../integrations/integrationToolMap');
    const synthesized = dryRunWithoutDispatch(step, ctx, runState, { mode, sideEffect, guardedIn, inputs, stepInputsSynthetic });
    if (synthesized) return synthesized;
    // What actually leaves the platform: placeholders, an irreversible mask, or
    // real values — decided per DESTINATION (an on-box Nextcloud is not a third
    // party) against the WHOLE run vault, so placeholders minted by an earlier
    // node resolve here too.
    const inMeta = resolveIntegration(step.tool, guardedIn.value, { nextcloudUrl: ctx.nextcloudUrl });
    // The path as resolved BEFORE egress masking (a tokenised path would never
    // match what the simulated steps recorded).
    const resolvedInputs = inputs;
    inputs = safety.prepareForEgress(guardedIn.value, policy, ctx, {
        destination: inMeta && inMeta.isLocal ? 'internal' : 'external',
    });

    // Defense-in-depth permission check (integrationActionGates.js).
    await assertStepToolPermitted(step, ctx, sideEffect, deps);
    const { executeTool } = deps.toolDispatcher();
    // Connection lending (GATED, default off): see integrationActionGates.js.
    const identity = await resolveLendingIdentity(step, ctx, deps);
    // ── "Ask this app only once" (step.askOnce; absent = off) — see
    // integrationActionMemo.js. A hit skips the dispatch, the egress row and
    // the shape cache — nothing left the box — and then falls into the SAME
    // tail below (guardToolOutput → restoreForRunState → buildPiiSummary), so
    // tokens are minted into THIS run's vault and the step's PII summary is
    // identical to a live call. The memo shortcuts the network and nothing else.
    const plan = await planReuse({ step, ctx, mode, inputs, inMeta, policy, identity, deps });
    const { hit, reused } = await readReuse(plan);
    const servedFromMemo = hit !== undefined;

    let result = hit;
    let probe = null;
    const dispatchT0 = Date.now();
    if (!servedFromMemo) {
        const ran = await dispatchTool(step, ctx, mode, { executeTool, inputs, identity, resolveIntegration });
        probe = ran.probe;
        if (!ran.result?.ok) {
            const err = ran.result?.error || new Error('tool dispatch failed');
            return dispatchFailed(step, ctx, mode, { err, inputs, resolvedInputs, probe, policy, auditBase, t0: dispatchT0, deps });
        }
        result = ran.result.value;
        rememberAnswer(plan, { step, stepUserId: identity.stepUserId, result, softFailure: deps.isToolErrorResult(result), deps });
        // ── Egress logging ── a real dispatch happened, so record where the data
        // went and what type it was. dry-run read-only calls are logged with
        // is_dry_run=true so Compliance Hub can exclude them.
        //
        // A MEMO HIT WRITES NO ROW, deliberately. integration_activity_log's
        // invariant is "bytes crossed the boundary, or were stopped at it", and its
        // two readers COUNT calls and take MAX(timestamp) — the Art. 44
        // external-transfer check and the RoPA. A synthetic row would assert a
        // transfer that did not happen and extend last_seen for a processor the org
        // did not contact this time. The probe columns would all be null too,
        // landing the row in "unknown" and making the ledger LESS accurate.
        await safety.logEgress({
            toolName: step.tool, toolArgs: inputs, result, probe, policy, auditBase, mode,
            durationMs: Date.now() - dispatchT0,
        });
    }

    const fallback = checkResult(step, ctx, mode, { result, inputs, resolvedInputs, deps });
    if (fallback) return fallback;
    // Cache the actual output shape so the Builder agent gets ground-truth
    // bindings on its next turn (no more guessing items vs results).
    // Only for real runs — dry-run synth output would pollute the cache.
    // A memo hit (run or durable) teaches nothing new: the shape was
    // recorded on the call that fetched it.
    if (mode !== 'dry_run' && !servedFromMemo) {
        try { await runnerPort('shapeCache').recordShape({ userId: ctx.userId, toolName: step.tool, output: result }); } catch (_) { bestEffort('core/automationRunner/execIntegrationAction:execIntegrationAction', _); /* output shape could not be cached, only the builder hints are affected */ }
    }
    // Scan the tool output (toolOutput scope) before it enters runState and is
    // bound by downstream steps. block → throws; redact/tokenize → transforms.
    const guardedOut = await safety.guardToolOutput(result, policy, auditBase, mode, ctx);
    // The tokens it just minted live in the run vault (guardToolOutput hands the
    // map back, so an unrestorable
    // `[person_1]` cannot end up in runState and, from there, in outgoing email).
    // runState holds real values; re-tokenization happens at the next egress.
    const outputForState = safety.restoreForRunState(guardedOut.result, ctx);
    // Categories the guards already detected (free — no extra scan) feed the
    // canvas's per-step PII summary; recorded next to the row, never in the
    // bindable output.
    const piiSummary = safety.buildPiiSummary([
        ...(guardedIn.categories || []),
        ...(guardedOut.categories || []),
    ]);
    // `reused` rides beside piiSummary rather than inside the output: the
    // output is the bindable namespace, and a step that suddenly grew a
    // `reused` key would break every downstream ref that walks it.
    // runDag does not persist it yet — automation_run_steps has no column for
    // it — so today it reaches only an in-process caller. The run SUMMARY
    // (execution.js) is what a person can see; the per-step line needs that
    // column, and until then this is the producing half of it.
    return { output: outputForState, ...(piiSummary ? { piiSummary } : {}), ...(reused ? { reused } : {}) };
}

// synthesizeDryRunOutput is re-exported for execAi's tool loop, so both
// executors reach automation/outputSchemas through the same port.
module.exports = { execIntegrationAction, synthesizeDryRunOutput };
