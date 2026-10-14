// @typecheck
/**
 * The gates execIntegrationAction passes before it dispatches (moved verbatim
 * out of its body): the defence-in-depth permission re-check, the connection
 * lending identity swap and the durable cross-run cache resolution. The
 * caller keeps the ORDER (permission, then lending, then the memo key, then
 * the durable tier); each helper only holds one block.
 *
 * `deps` (from execAi.js, through execIntegrationAction) carries the lazy
 * getters for what sits in the server's large import cycle
 * (integrationTools, connectionResolution, integrationCachePolicy), so this
 * module stays out of the cycle (lint:scc-ratchet).
 */

const log = require('../../telemetry/log');
// The built-in step-type table is automation/'s, reached through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');

/**
 * Throws when `step.tool` is no longer in the user's CURRENT allowed tool set.
 * Caches the set on `ctx.allowedToolNames` (null = lookup failed for a
 * read-only tool; skip the check for the rest of the run).
 */
async function assertStepToolPermitted(step, ctx, sideEffect, deps) {
    // Defense-in-depth permission check. The catalog filter that the
    // builder used at design-time may be out of date by the time a
    // scheduled automation fires (org admin disabled the integration,
    // user got removed from a group, etc.). Re-resolve the user's
    // *current* allowed tool set and refuse if `step.tool` is no longer
    // in it. Mirrors the n8nWorkflow pattern in toolDispatcher.js.
    if (!ctx.allowedToolNames) {
        try {
            const { getIntegrationTools } = deps.integrationTools();
            // Connection lending (gated): when this automation is run on behalf of a
            // non-owner (ctx.resourceOwnerUserId set by automation-sharing) the
            // owner's LENT providers' tools must be in the allowed set too, else
            // the permission gate below would reject a validly-borrowed tool.
            // Inert unless the flag is on AND an owner is provided.
            const lendPolicy = (ctx.resourceOwnerUserId && ctx.resourceOwnerUserId !== ctx.userId)
                ? { ownerUserId: ctx.resourceOwnerUserId, resourceType: 'automation', resourceId: ctx.automationId || null }
                : null;
            const r = await getIntegrationTools({
                userId: ctx.userId,
                session: ctx.session,
                isAdmin: !!ctx.session?.isAdmin || ctx.session?.user?.role === 'admin',
                automationStep: true,
                connectionPolicy: lendPolicy,
            });
            ctx.allowedToolNames = new Set((r.tools || []).map(t => t?.function?.name).filter(Boolean));
        } catch (e) {
            // If we can't resolve the catalog, fail closed for side-effects
            // and pass-through for read-only tools.
            log.warn(`[AutomationRunner] Permission catalog lookup failed: ${e.message}`);
            if (sideEffect) throw new Error('Could not verify your permission for this tool. The automation has been paused — please re-open it after refreshing your permissions.');
            ctx.allowedToolNames = null; // sentinel — skip subsequent checks this run
        }
    }
    if (ctx.allowedToolNames && !ctx.allowedToolNames.has(step.tool)) {
        // "Not in your allowed set" has two very different causes. A built-in
        // step type here means the step names something that was never a tool
        // (an AI builder passed it to builder_add_action), and no admin toggle
        // can fix that — telling the user to ask their admin sends them to
        // someone who cannot help.
        const { isBuiltinStepType } = runnerPort('stepTypes');
        if (isBuiltinStepType(step.tool)) {
            throw new Error(`Step "${step.id}" is an integration action calling "${step.tool}", but "${step.tool}" `
                + `is a built-in step type, not an integration. This step was built incorrectly — delete it and add `
                + `a real "${step.tool}" step in its place. No integration setting can fix this.`);
        }
        throw new Error(`You no longer have permission to use "${step.tool}". Ask your organisation admin to re-enable this integration, or remove the step from the automation.`);
    }
}

/**
 * The identity a step dispatches as: the runner's own, or (lending on, a
 * resource owner distinct from the runner) the owner's lent connection.
 */
async function resolveLendingIdentity(step, ctx, deps) {
    // Connection lending (GATED, default off): an automation run on behalf of a
    // non-owner may borrow the owner's named connection for this step. Inert
    // unless INTEGRATION_CONNECTION_LENDING_ENABLED is set AND a resource owner
    // distinct from the runner is provided — so today's behavior is unchanged.
    let stepUserId = ctx.userId;
    let stepOrgId = ctx.orgId;
    let lentConnection = null;
    try {
        const cr = deps.connectionResolution();
        if (cr.isLendingEnabled() && ctx.resourceOwnerUserId && ctx.resourceOwnerUserId !== ctx.userId) {
            if (!ctx.__runCtx) ctx.__runCtx = await cr.runningUserContext(ctx.userId);
            const ov = await cr.resolveEffectiveIdentity({
                toolName: step.tool, runningUserId: ctx.userId,
                runningUserOrgId: ctx.__runCtx.orgId, runningUserGroups: ctx.__runCtx.groups,
                ownerUserId: ctx.resourceOwnerUserId,
                resourceType: 'automation', resourceId: ctx.automationId || null,
            });
            if (ov) { stepUserId = ov.integrationUserId; stepOrgId = ov.integrationOrgId; lentConnection = ov; }
        }
    } catch (_) { /* fail closed to bring-your-own */ }
    return { stepUserId, stepOrgId, lentConnection };
}

/**
 * The durable tier descriptor for this call, or null when it must not be used.
 */
async function resolveDurableTier({ memo, memoEligible, step, stepOrgId, callIdentity, memoTtlMs, deps }) {
    // ── The DURABLE tier (step.askOnce.acrossRuns; absent = off) ──
    //
    // Everything the run memo gets for free — no crossing a user, an org, a run
    // or a replica — has to be earned here, so this rides on top of the memo's
    // eligibility rather than beside it: a call the memo would refuse can never
    // reach the durable cache. On top of that it needs all three switches:
    // the process env, the organisation's own opt-in, and this step's tick.
    //
    // stepOrgId, not ctx.orgId: after a lend the answer belongs to the lender's
    // organisation, and storing it under the runner's would be the cross-tenant
    // leak the whole key scheme exists to prevent.
    //
    // `!memo.hasSlept()`: a Wait clears the run memo precisely so the next
    // look-up is asked again, and without this the call would fall THROUGH to
    // the durable cache and be handed the same pre-sleep answer — whose TTL is
    // up to an hour, far longer than most Waits.
    let durable = null;
    if (memoEligible && !memo.hasSlept() && step.askOnce && typeof step.askOnce === 'object'
        && step.askOnce.acrossRuns === true && stepOrgId) {
        try {
            const { resolveCachePolicy } = deps.integrationCachePolicy();
            const cachePolicy = await resolveCachePolicy(stepOrgId);
            // `scopes.integration` is the app-look-up half of the org's one
            // consent row (the other half is outbound HTTP — see httpCache.js).
            // It defaults ON for a row written before scopes existed, so this
            // is unchanged for every org that already opted in; without the
            // check the tick on the settings screen would do nothing.
            if (cachePolicy.enabled && cachePolicy.scopes && cachePolicy.scopes.integration === true) {
                const store = require('../../stores/integrationCacheStore');
                // The per-step ttl still applies, capped by the org's. Kept as
                // its own field because the write path re-resolves the ORG half
                // below and has to re-apply this cap against the fresh value.
                const stepTtlSeconds = memoTtlMs ? Math.round(memoTtlMs / 1000) : null;
                durable = {
                    store,
                    key: store.cacheKey(callIdentity),
                    organizationId: stepOrgId,
                    stepTtlSeconds,
                    ttlSeconds: Math.min(cachePolicy.ttlSeconds, stepTtlSeconds ?? cachePolicy.ttlSeconds),
                };
            }
        } catch (e) {
            // A cache that cannot be consulted is a cache miss, never an error:
            // the only correct response is to make the call for real.
            log.warn('[AutomationRunner] durable cache unavailable:', e.message);
            durable = null;
        }
    }
    return durable;
}

module.exports = { assertStepToolPermitted, resolveLendingIdentity, resolveDurableTier };
