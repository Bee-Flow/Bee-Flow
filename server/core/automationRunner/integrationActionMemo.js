/**
 * "Ask this app only once" for the integration-action step
 * (./execIntegrationAction.js): the run memo (step.askOnce) and the durable
 * cross-run tier (step.askOnce.acrossRuns), which key, when a call may be
 * served from them, and the write-back after a live answer.
 *
 * Placement is the security property, and it stays in the executor: the plan
 * is made AFTER the defence-in-depth permission re-check and AFTER the lending
 * identity swap, so a user whose access was revoked cannot be served from the
 * memo, and a borrowed connection is part of the key rather than invisible to
 * it.
 */

'use strict';

const { isMemoisable } = require('../automationModel/sideEffectMap');
const { memoKeyParts, memoKeyFromParts, MAX_ENTRY_BYTES } = require('./toolMemo');
const { resolveDurableTier } = require('./integrationActionGates');
const log = require('../../telemetry/log');

/**
 * Whether, and under which key, this call may be answered from memory.
 *
 * egressMode must be 'real': under 'tokenize' the outgoing args are run-vault
 * placeholders and under 'redact' every person collapses to the literal
 * [person]. Within one run those labels are stable, so this is belt and
 * braces here — but it is DISQUALIFYING for anything durable, and having the
 * line in now forecloses the whole class.
 * envFlagOn, not bare truthiness: `AUTOMATION_ASK_ONCE_DISABLED=0` is a
 * non-empty string, so `!process.env.X` read the operator's "leave it on"
 * as "switch it off" — the same grammar the durable tier's kill switch
 * already used, now shared so the two switches cannot drift.
 */
async function planReuse({ step, ctx, mode, inputs, inMeta, policy, identity, deps }) {
    const { safety, envFlagOn } = deps;
    const { stepUserId, stepOrgId, lentConnection } = identity;
    const memo = ctx._toolMemo;
    const destination = inMeta && inMeta.isLocal ? 'internal' : 'external';
    const memoEligible = !!memo
        && !envFlagOn('AUTOMATION_ASK_ONCE_DISABLED')
        && mode !== 'dry_run'
        && !!step.askOnce
        && isMemoisable(step.tool)
        && safety.egressMode(policy, destination) === 'real';
    const callIdentity = memoEligible ? memoKeyParts({
        toolName: step.tool,
        stepUserId, stepOrgId,
        connectionId: lentConnection?.connectionId,
        grantId: lentConnection?.grantId,
        integrationServer: inMeta?.server,
        destination,
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
    return { memo, memoEligible, memoK, memoTtlMs, durable };
}

/**
 * The remembered answer, if there is one: `{ hit, reused }` with `hit`
 * undefined on a miss. `reused` is provenance, not a boolean. "We asked once
 * instead of two hundred times" and "we did not contact this app at all
 * today" are different facts about a run, and only the second one explains an
 * answer that predates the run. Without it the inspector renders a replayed
 * answer identically to a live one, so a person debugging "why did this act on
 * yesterday's data" has nothing to look at.
 */
async function readReuse(plan) {
    const { memo, memoEligible, memoK, memoTtlMs, durable } = plan;
    let hit = memoEligible ? memo.peek(memoK) : undefined;
    let reused = hit === undefined ? null : 'run';
    // The durable tier is consulted only AFTER the run memo misses, and a hit
    // is written back into the memo so the rest of this run answers from
    // memory rather than the database.
    if (hit === undefined && durable) {
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
            hit = row.value;
            reused = 'stored';
            memo.recordDurableHit();
            memo.store(memoK, hit, memoTtlMs);
        }
    }
    return { hit, reused };
}

/**
 * Remember a live answer. A tool that returns a SOFT `{ error }` object is a
 * failed step (the executor throws on it a few lines later) but did not throw
 * at the dispatch, which is how it slipped past "a failure is never stored".
 * Caching it serves "not authorised" as this call's answer to every later run
 * for the whole TTL, and each of those runs fails with no request to the app
 * to explain why.
 */
function rememberAnswer(plan, { step, stepUserId, result, softFailure, deps }) {
    const { memo, memoEligible, memoK, memoTtlMs, durable } = plan;
    if (memoEligible && !softFailure) memo.store(memoK, result, memoTtlMs);
    // Written AFTER the dispatch succeeded, so a failure is never stored:
    // a transient 500 must not become the answer for the next hour. Not
    // awaited on the critical path — a slow write must not slow the step,
    // and a failed one is only a future miss.
    if (!durable || softFailure) return;
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

module.exports = { planReuse, readReuse, rememberAnswer };
