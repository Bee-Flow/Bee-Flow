// @typecheck
/**
 * "Reuse the answer" for the ai_step: the run memo (step.askOnce) and the
 * durable cross-run tier (step.askOnce.acrossRuns), which key, when a model
 * call may be answered from them, and the write-back after an accepted answer.
 * Mirrors integrationActionMemo.js / integrationActionGates.js, which do the
 * same for an integration action.
 *
 * ── WHY KEYING ON THE GUARDED MESSAGES IS SAFE ACROSS RUNS ──────────
 * The key is made from the request AFTER the Privacy Shield rewrote it
 * (guardAiInput): the tokenised or redacted messages, the schema, the model,
 * the provider connection and the sampling options, plus the user and the
 * organisation. A model's answer is a function of exactly what it saw, so two
 * runs whose tokenised input is identical get the answer the model would have
 * given them anyway: under `tokenize` the model sees `<PERSON_1>` in both runs
 * and cannot tell whose name the vault holds behind it; under `redact` it sees
 * `[person]`. That is the opposite of an integration look-up, where the app
 * itself sees the real argument and a placeholder would hand one person's
 * record to another (which is why integrationActionMemo refuses the durable
 * tier unless egressMode is 'real'). Nothing real ever sat behind the key here.
 *
 * What is stored is the model's raw accepted answer, BEFORE guardAiOutput. A
 * hit therefore takes the very same tail as a live answer (guardAiOutput, then
 * restoreForRunState, then the checks) and mints its values into THIS run's
 * vault; no real value is ever stored in clear, and no vault outlives its run.
 *
 * ── WHEN IT IS USED ─────────────────────────────────────────────────
 * Never in a dry run (except a golden replay or form-scenario dry run that asks
 * to reuse stored answers, ctx.testHarness.aiAnswers === 'cache': it READS both
 * tiers and writes only the run memo, never the durable tier), never when the
 * model was offered tools (a tool call has
 * side effects and its answer depends on the world, not on the prompt), never
 * with AUTOMATION_ASK_ONCE_DISABLED on. The durable tier additionally needs
 * the step's `askOnce.acrossRuns`, an organisation that opted in
 * (policy.enabled and scopes.ai: the integration tick alone is not consent to
 * store model answers), a run that has not slept or resumed from a pause, and
 * the INTEGRATION_CACHE_DISABLED kill switch off. A cache that cannot be read
 * is a miss, never an error, and a write never fails a step. The caller hands
 * over only an accepted, non-truncated answer, never a fallback value.
 */

'use strict';

const { memoKeyParts, memoKeyFromParts, MAX_ENTRY_BYTES } = require('./toolMemo');
const { resolveCachePolicy, resolveCachePolicyFresh, envFlagOn } = require('./integrationCachePolicy');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const MAX_STEP_TTL_SECONDS = 900;

/** The answer as it is kept: an allow-list of the two fields, nothing else. */
function pickAnswer(answer) {
    const content = answer && typeof answer.content === 'string' ? answer.content : null;
    const structured = answer && answer.structured && typeof answer.structured === 'object' ? answer.structured : null;
    return { content, structured };
}

/** A stored value is only trusted when it has the shape pickAnswer writes. */
function isAnswer(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const contentOk = v.content === null || typeof v.content === 'string';
    const structuredOk = v.structured === null || (typeof v.structured === 'object' && !Array.isArray(v.structured));
    return contentOk && structuredOk && (v.content !== null || v.structured !== null);
}

/** The step's own window in ms, clamped to 1..900 s, or undefined for the memo default. */
function stepTtlMs(step) {
    const a = step.askOnce;
    const n = a && typeof a === 'object' ? Number(a.ttlSeconds) : NaN;
    return n ? Math.max(1, Math.min(MAX_STEP_TTL_SECONDS, n)) * 1000 : undefined;
}

/**
 * The durable tier descriptor, or null when it must not be used.
 * Everything that is not an explicit yes is a no.
 */
async function resolveAiDurableTier({ step, ctx, memo, identity, memoTtlMs }) {
    const a = step.askOnce;
    if (!(a && typeof a === 'object' && a.acrossRuns === true && ctx.orgId && !memo.hasSlept())) return null;
    try {
        const cachePolicy = await resolveCachePolicy(ctx.orgId);
        // `scopes.ai` is its own tick: the integration scope (on for older
        // consent rows) never covers storing model answers.
        if (!(cachePolicy.enabled && cachePolicy.scopes && cachePolicy.scopes.ai === true)) return null;
        const store = require('../../stores/integrationCacheStore');
        const stepTtlSeconds = memoTtlMs ? Math.round(memoTtlMs / 1000) : null;
        return {
            store,
            key: store.cacheKey(identity),
            organizationId: ctx.orgId,
            stepTtlSeconds,
            ttlSeconds: Math.min(cachePolicy.ttlSeconds, stepTtlSeconds ?? cachePolicy.ttlSeconds),
        };
    } catch (e) {
        log.warn('[AiStepCache] durable cache unavailable:', e.message);
        return null;
    }
}

/**
 * Whether, and under which key, this model call may be answered from memory.
 * `request` is what is about to go out, after guardAiInput.
 *
 * @param {{ step: any, ctx: any, mode: string, policy: any, modelId: string, providerKey: string,
 *   toolsOffered: boolean, request: { route: 'structured'|'prompt', messages: any[], schema: any,
 *   temperature: number, maxOutputTokens: number|null, reasoningEffort: string|null } }} args
 * @returns {Promise<any|null>} null when reuse does not apply
 */
async function planAiReuse({ step, ctx, mode, policy, modelId, providerKey, toolsOffered, request }) {
    const memo = ctx && ctx._toolMemo;
    // A dry run reuses stored answers only when the test harness asks, and then
    // read-only (plan.readOnly): a test run never fills the durable cache.
    const readOnly = mode === 'dry_run' && ctx?.testHarness?.aiAnswers === 'cache';
    if ((mode !== 'live' && !readOnly) || !step.askOnce || envFlagOn('AUTOMATION_ASK_ONCE_DISABLED')
        || !memo || toolsOffered || ctx.stepInputsSynthetic) return null;
    const identity = memoKeyParts({
        toolName: 'ai_step',
        stepUserId: ctx.userId,
        stepOrgId: ctx.orgId,
        connectionId: providerKey,
        grantId: undefined,
        integrationServer: modelId,
        destination: 'external',
        policyAction: policy?.action,
        policyScope: policy?.privacyScope,
        args: { v: 1, ...request },
    });
    const memoTtlMs = stepTtlMs(step);
    const durable = await resolveAiDurableTier({ step, ctx, memo, identity, memoTtlMs });
    return { memo, memoK: memoKeyFromParts(identity), memoTtlMs, durable, userId: ctx.userId, readOnly };
}

/**
 * The remembered answer, if there is one: `{ hit, reused }` with `hit`
 * undefined on a miss. `reused` says where it came from: 'run' (this run asked
 * the same thing earlier) or 'stored' (an earlier run did).
 * @returns {Promise<{ hit?: { content: string|null, structured: object|null }, reused: 'run'|'stored'|null }>}
 */
async function readAiReuse(plan) {
    if (!plan) return { reused: null };
    const { memo, memoK, memoTtlMs, durable } = plan;
    let hit;
    try { hit = memo.peek(memoK); } catch { hit = undefined; }
    if (isAnswer(hit)) return { hit, reused: 'run' };
    if (!durable) return { reused: null };
    // maxAgeSeconds is the window as it stands now, so an admin who shortened
    // the organisation's window is not served the old answers until their
    // original expiry.
    let row = null;
    try {
        row = await durable.store.get(durable.key, durable.organizationId, { maxAgeSeconds: durable.ttlSeconds });
    } catch (e) {
        log.warn('[AiStepCache] durable cache read failed:', e.message);
    }
    if (!row || !isAnswer(row.value)) return { reused: null };
    const answer = pickAnswer(row.value);
    memo.recordDurableHit();
    memo.store(memoK, answer, memoTtlMs);
    return { hit: answer, reused: 'stored' };
}

/**
 * Remember an accepted answer. The durable write is not awaited and re-reads
 * the organisation's policy without the 30 second memo first: invalidation is
 * in-process only, so a replica that has not seen "switch it off" would
 * otherwise refill the table behind the admin.
 * @param {any} plan
 * @param {{ answer: { content: string|null, structured: object|null }, userId?: string }} args
 */
function rememberAiAnswer(plan, { answer, userId }) {
    if (!plan) return;
    const value = pickAnswer(answer);
    if (value.content === null && value.structured === null) return;
    const { memo, memoK, memoTtlMs, durable } = plan;
    try {
        memo.store(memoK, value, memoTtlMs);
    } catch (e) {
        log.debug(`[AiStepCache] run memo could not store (only a future miss): ${e.message}`);
    }
    // A read-only plan (dry run reusing stored answers) never writes the durable tier.
    if (!durable || plan.readOnly) return;
    (async () => {
        const fresh = await resolveCachePolicyFresh(durable.organizationId);
        if (!fresh.enabled || !fresh.scopes || fresh.scopes.ai !== true) return;
        await durable.store.put({
            key: durable.key,
            organizationId: durable.organizationId,
            userId: userId || plan.userId,
            toolName: 'ai_step',
            value,
            // The fresh organisation window, still capped by the step's own.
            ttlSeconds: Math.min(fresh.ttlSeconds, durable.stepTtlSeconds ?? fresh.ttlSeconds),
            maxBytes: MAX_ENTRY_BYTES,
        });
    })().catch((e) => bestEffort('core/automationRunner/aiStepCache:rememberAiAnswer', e));
}

module.exports = { planAiReuse, readAiReuse, rememberAiAnswer };
