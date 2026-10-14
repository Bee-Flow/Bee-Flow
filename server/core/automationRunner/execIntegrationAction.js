/**
 * The integration-action step executor (moved verbatim out of execAi.js):
 * the safety gates, the permission re-check, connection lending, the run
 * memo / durable cross-run cache and the dispatch itself. execAi.js
 * re-exports it, so importers keep requiring './execAi'.
 *
 * `deps` (the last argument) carries what sits in the server's large import
 * cycle (safety, the ./shared result helpers, envFlagOn, and lazy getters
 * for integrationCachePolicy, toolDispatcher, integrationTools and
 * connectionResolution). execAi.js requires those and hands them over, so
 * this module and ./integrationActionGates stay out of the cycle
 * (lint:scc-ratchet) and nothing loads earlier than before.
 */

const { resolveInputs } = require('../automationModel/bind');
const { isSideEffect, isMemoisable } = require('../automationModel/sideEffectMap');
const { memoKeyParts, memoKeyFromParts, MAX_ENTRY_BYTES } = require('./toolMemo');
const { synthesizeDryRunOutput } = require('../../automation/outputSchemas');
const shapeCache = require('../../automation/shapeCache');
const { runWithProbe, markLocal } = require('../http/outboundProbe');
const log = require('../../telemetry/log');
const { assertStepToolPermitted, resolveLendingIdentity, resolveDurableTier } = require('./integrationActionGates');

// ── Step executors ──────────────────────────────────────

async function execIntegrationAction(step, ctx, runState, mode, deps) {
    // Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
    // the agent/direct-chat pipeline so automations stop bypassing those controls.
    const {
        safety,
        envFlagOn,
        isEmptyToolResult,
        isToolErrorResult,
        isEnvironmentToolError,
        enrichNextcloudError,
        stepInputsSynthetic,
    } = deps;
    // Tool arguments are data, not prose: a list in a `{{…}}` stays JSON.
    let inputs = resolveInputs(step.inputs || {}, runState, { allowSecrets: true, listAs: 'json' });
    const sideEffect = isSideEffect(step.tool);

    // ── Safety: scan resolved inputs (toolInput scope) before anything leaves ──
    // the platform. On a `block` action this throws GuardrailBlockError, which
    // flows through dispatchStep's catch → on_error edge or a fail-loud run.
    const policy = await safety.resolveAutomationPolicy(ctx);
    const auditBase = safety.buildAuditBase(ctx, step);
    const { resolveIntegration } = require('../integrations/integrationToolMap');
    let guardedIn;
    try {
        guardedIn = await safety.guardToolInput(inputs, policy, auditBase, mode, ctx);
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

    if (mode === 'dry_run' && sideEffect) {
        // No real dispatch in a side-effect dry-run, so nothing egresses — but
        // still surface a "would block" annotation for the builder preview.
        const out = synthesizeDryRunOutput(step.tool, inputs);
        if (guardedIn.wouldBlock) out._guardrailWouldBlock = guardedIn.categories;
        return { output: out, dryRunSynthesised: true };
    }
    if (mode === 'dry_run' && guardedIn.wouldBlock) {
        // Read-only tool in a dry-run: a `block` action returns the payload
        // UNTRANSFORMED, and this used to fall straight through to a live
        // dispatch — so the one mode that must never leak sent the raw value to
        // a third party. Synthesize instead, and keep the preview annotation.
        const out = synthesizeDryRunOutput(step.tool, inputs);
        out._guardrailWouldBlock = guardedIn.categories;
        return { output: out, dryRunSynthesised: true, dryRunFallback: 'guardrail_block' };
    }
    if (mode === 'dry_run' && stepInputsSynthetic(step, runState, ctx)) {
        // Read tool, but its inputs derive from SYNTHESIZED upstream data
        // (sample fallback / simulated side-effect / synthetic trigger).
        // Dispatching fake ids live guarantees a provider error per call —
        // synthesize directly instead of hammering the API.
        const out = synthesizeDryRunOutput(step.tool, inputs);
        return { output: out, dryRunSynthesised: true, dryRunFallback: 'synthetic_input' };
    }
    // What actually leaves the platform: placeholders, an irreversible mask, or
    // real values — decided per DESTINATION (an on-box Nextcloud is not a third
    // party) against the WHOLE run vault, so placeholders minted by an earlier
    // node resolve here too.
    const inMeta = resolveIntegration(step.tool, guardedIn.value, { nextcloudUrl: ctx.nextcloudUrl });
    inputs = safety.prepareForEgress(guardedIn.value, policy, ctx, {
        destination: inMeta && inMeta.isLocal ? 'internal' : 'external',
    });

    // Defense-in-depth permission check (integrationActionGates.js).
    await assertStepToolPermitted(step, ctx, sideEffect, deps);

    const { executeTool } = deps.toolDispatcher();

    // Connection lending (GATED, default off): see integrationActionGates.js.
    const { stepUserId, stepOrgId, lentConnection } = await resolveLendingIdentity(step, ctx, deps);

    // ── "Ask this app only once per run" (step.askOnce; absent = off) ──
    //
    // Placement is the security property. This sits AFTER the defence-in-depth
    // permission re-check above and AFTER the lending identity swap, so a user
    // whose access was revoked cannot be served from the memo, and a borrowed
    // connection is part of the key rather than invisible to it.
    //
    // egressMode must be 'real': under 'tokenize' the outgoing args are run-vault
    // placeholders and under 'redact' every person collapses to the literal
    // [person]. Within one run those labels are stable, so this is belt and
    // braces here — but it is DISQUALIFYING for anything durable, and having the
    // line in now forecloses the whole class.
    // envFlagOn, not bare truthiness: `AUTOMATION_ASK_ONCE_DISABLED=0` is a
    // non-empty string, so `!process.env.X` read the operator's "leave it on"
    // as "switch it off" — the same grammar the durable tier's kill switch
    // already used, now shared so the two switches cannot drift.
    const memo = ctx._toolMemo;
    const memoEligible = !!memo
        && !envFlagOn('AUTOMATION_ASK_ONCE_DISABLED')
        && mode !== 'dry_run'
        && !!step.askOnce
        && isMemoisable(step.tool)
        && safety.egressMode(policy, inMeta && inMeta.isLocal ? 'internal' : 'external') === 'real';
    const callIdentity = memoEligible ? memoKeyParts({
        toolName: step.tool,
        stepUserId, stepOrgId,
        connectionId: lentConnection?.connectionId,
        grantId: lentConnection?.grantId,
        integrationServer: inMeta?.server,
        destination: inMeta && inMeta.isLocal ? 'internal' : 'external',
        policyAction: policy?.action,
        policyScope: policy?.privacyScope,
        args: inputs,
    }) : null;
    const memoK = callIdentity === null ? null : memoKeyFromParts(callIdentity);
    const memoTtlMs = (step.askOnce && typeof step.askOnce === 'object' && Number(step.askOnce.ttlSeconds))
        ? Math.max(1, Math.min(900, Number(step.askOnce.ttlSeconds))) * 1000
        : undefined;

    // ── The DURABLE tier (step.askOnce.acrossRuns; absent = off) ──
    // Resolved in integrationActionGates.js; null means "do not use it".
    const durable = await resolveDurableTier({ memo, memoEligible, step, stepOrgId, callIdentity, memoTtlMs, deps });

    let result;
    let probe = null;
    const dispatchT0 = Date.now();
    // A hit skips the dispatch, the egress row and the shape cache — nothing
    // left the box, so there is nothing to log and no new shape to learn. It
    // then falls into the SAME tail below (guardToolOutput → restoreForRunState
    // → buildPiiSummary), so tokens are minted into THIS run's vault and the
    // step's PII summary is identical to a live call. The memo shortcuts the
    // network and nothing else.
    let memoHit = memoEligible ? memo.peek(memoK) : undefined;
    // Provenance, not a boolean. "We asked once instead of two hundred times"
    // and "we did not contact this app at all today" are different facts about
    // a run, and only the second one explains an answer that predates the run.
    // Without it the inspector renders a replayed answer identically to a live
    // one, so a person debugging "why did this act on yesterday's data" has
    // nothing to look at.
    let reused = memoHit === undefined ? null : 'run';
    // The durable tier is consulted only AFTER the run memo misses, and a hit
    // is written back into the memo so the rest of this run answers from
    // memory rather than the database.
    if (memoHit === undefined && durable) {
        // maxAgeSeconds is the window as it stands NOW. expires_at was stamped
        // when the row was written, so an admin who shortened the org's window
        // after noticing stale data would otherwise keep being served the old
        // answers until the OLD expiry — up to an hour later.
        //
        // Wrapped because a broken cache must only ever be a MISS. The store
        // swallows its own failures today, so this is the guarantee stated
        // rather than assumed: nothing about a step's correctness may depend
        // on the cache being reachable.
        let row = null;
        try {
            row = await durable.store.get(durable.key, durable.organizationId, {
                maxAgeSeconds: durable.ttlSeconds,
            });
        } catch (e) {
            log.warn('[AutomationRunner] durable cache read failed:', e.message);
        }
        if (row) {
            memoHit = row.value;
            reused = 'stored';
            memo.recordDurableHit();
            memo.store(memoK, memoHit, memoTtlMs);
        }
    }
    const servedFromMemo = memoHit !== undefined;
    if (servedFromMemo) {
        result = memoHit;
    } else {
        // Wrap in runWithProbe so the global fetch shim captures the destination
        // IP for the egress row. markLocal keeps on-host integrations honest.
        // The inner fn never THROWS through runWithProbe — a throw used to
        // discard the probe, and with it the audit row for a failed call whose
        // bytes had already left the box.
        const ran = await runWithProbe(async () => {
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
                        session: ctx.session,
                        orgId: stepOrgId,
                        userGroupIds: ctx.userGroupIds || [],
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
        probe = ran.probe;
        if (!ran.result?.ok) {
            const err = ran.result?.error || new Error('tool dispatch failed');
            // Read-only tool fallback in dry-run: when a search/read tool fails
            // (auth lapsed, query yielded nothing, transient API hiccup) the
            // automation builder still needs a workable bind target downstream.
            // Substitute the curated sample so the AI can keep planning.
            // A REAL dispatch happened in both modes (dry-run dispatches
            // read-only tools live) — the failed call's bytes already left the
            // box, so both modes get a status='error' row. Dry-run rows carry
            // is_dry_run=true, same as the success path at the bottom.
            await safety.logEgress({
                toolName: step.tool, toolArgs: inputs, error: err, probe, policy, auditBase, mode,
                durationMs: Date.now() - dispatchT0,
            });
            if (mode === 'dry_run') {
                const fallback = synthesizeDryRunOutput(step.tool, inputs);
                // Dedupe the warning per (tool, message) — a fan-out used to spam
                // dozens of identical lines per dry-run.
                const logKey = `${step.tool}:${err.message}`;
                ctx._dryRunFallbackLogged = ctx._dryRunFallbackLogged || new Set();
                if (!ctx._dryRunFallbackLogged.has(logKey)) {
                    ctx._dryRunFallbackLogged.add(logKey);
                    log.warn(`[AutomationRunner] dry-run: live ${step.tool} failed, using sample (${err.message})`);
                }
                return { output: fallback, dryRunSynthesised: true, dryRunFallback: 'live_failed' };
            }
            throw enrichNextcloudError(step.tool, err);
        }
        result = ran.result.value;
        // A tool that returns a SOFT `{ error }` object throws a few lines
        // below (isToolErrorResult), so it is a failed step — but it did not
        // throw HERE, which is how it slipped past "a failure is never
        // stored". Caching it serves "not authorised" as this call's answer to
        // every later run for the whole TTL, and each of those runs fails with
        // no request to the app to explain why.
        const softFailure = isToolErrorResult(result);
        if (memoEligible && !softFailure) memo.store(memoK, result, memoTtlMs);
        // Written AFTER the dispatch succeeded, so a failure is never stored:
        // a transient 500 must not become the answer for the next hour. Not
        // awaited on the critical path — a slow write must not slow the step,
        // and a failed one is only a future miss.
        if (durable && !softFailure) {
            // The org policy is re-read WITHOUT the 30-second memo before the
            // row is written. invalidateCachePolicy is in-process only, so a
            // replica that has not seen the admin's "switch it off and delete
            // everything" would otherwise refill the table right behind them.
            // A durable write is rare next to the step hot path, so the extra
            // config read is cheap; the READ above stays memoised.
            (async () => {
                const { resolveCachePolicyFresh } = deps.integrationCachePolicy();
                const fresh = await resolveCachePolicyFresh(durable.organizationId);
                if (!fresh.enabled || !fresh.scopes || fresh.scopes.integration !== true) return;
                await durable.store.put({
                    key: durable.key,
                    organizationId: durable.organizationId,
                    userId: stepUserId,
                    toolName: step.tool,
                    value: result,
                    // The fresh org window, still capped by the step's own.
                    ttlSeconds: Math.min(fresh.ttlSeconds, durable.stepTtlSeconds ?? fresh.ttlSeconds),
                    maxBytes: MAX_ENTRY_BYTES,
                });
            })().catch(() => { /* a cache write is never worth failing a step */ });
        }
    }

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
    if (!servedFromMemo) {
        await safety.logEgress({
            toolName: step.tool, toolArgs: inputs, result, probe, policy, auditBase, mode,
            durationMs: Date.now() - dispatchT0,
        });
    }

    // Empty-result fallback: a live read-only call that returned no rows
    // teaches the AI nothing about field shapes. In dry-run, swap in the
    // sample so downstream binding decisions are made against realistic
    // data. (Live mode keeps the empty result — the user wanted truth.)
    if (mode === 'dry_run' && isEmptyToolResult(result)) {
        const fallback = synthesizeDryRunOutput(step.tool, inputs);
        return { output: fallback, dryRunSynthesised: true, dryRunFallback: 'live_empty' };
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
    if (isToolErrorResult(result)) {
        if (mode === 'dry_run' && isEnvironmentToolError(result.error)) {
            const fallback = synthesizeDryRunOutput(step.tool, inputs);
            return { output: fallback, dryRunSynthesised: true, dryRunFallback: 'not_connected' };
        }
        const err = new Error(`${step.tool} failed: ${String(result.error)}`);
        err.toolError = true;
        throw enrichNextcloudError(step.tool, err, String(result.error));
    }
    // Cache the actual output shape so the Builder agent gets ground-truth
    // bindings on its next turn (no more guessing items vs results).
    // Only for real runs — dry-run synth output would pollute the cache.
    // A run-memo hit teaches nothing new — the shape was recorded when the
    // answer was first fetched, moments ago in this same run. A DURABLE hit
    // skips it too: the shape was recorded on the run that fetched it, and
    // re-deriving one from a replayed payload would add nothing the builder
    // does not already have.
    if (mode !== 'dry_run' && !servedFromMemo) {
        try { await shapeCache.recordShape({ userId: ctx.userId, toolName: step.tool, output: result }); } catch (_) {}
    }
    // Scan the tool output (toolOutput scope) before it enters runState and is
    // bound by downstream steps. block → throws; redact/tokenize → transforms.
    const guardedOut = await safety.guardToolOutput(result, policy, auditBase, mode, ctx);
    // The tokens it just minted live in the run vault (guardToolOutput hands the
    // map back now — it used to drop it, which is how an unrestorable
    // `[person_1]` ended up in runState and, from there, in outgoing email).
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

// synthesizeDryRunOutput is re-exported for execAi's tool loop: one require
// of automation/outputSchemas for both executors (layering ratchet).
module.exports = { execIntegrationAction, synthesizeDryRunOutput };
