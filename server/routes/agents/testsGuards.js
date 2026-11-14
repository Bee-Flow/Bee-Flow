// @typecheck
/**
 * Agent tests: what a run reports about the version it exercised, the three preflights a
 * model call shares (workspace, plan ceiling, fast tier), each failing
 * closed, and the usage rows of the model calls. Split out of
 * routes/agents/tests.js; behaviour unchanged.
 */

const { usageLogFields } = require('../../core/providers/usageNormalizer');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { resolveUserOrgIds } = require('../../auth');

// The gate every route here shares is requireAgentGrade('edit', { views: true })
// from ./crud in each route's chain (auth/agentAccess.mts): unreadable is 404,
// readable but not editable is 403, and the handler reads agentAccessOf(req).

/**
 * What the run reports about the agent it actually exercised.
 * @param {{ draft: { published_version?: number, rev?: number, published_rev?: number } | null; runtime: { runtimeSource?: string } | null; }} views
 */
function versionInfo(views) {
    const agent = views.draft || {};
    const publishedVersion = Number(agent.published_version) || 0;
    const runtimeSource = views.runtime && views.runtime.runtimeSource;
    const known = runtimeSource === 'published' || runtimeSource === 'live';
    // An unreadable projection with a published version behind it counts as
    // PUBLISHED. The other way round is the reassuring answer: recording 0
    // means "the concept ran", which tells the publish dialog these results
    // describe exactly what you are about to ship — the one claim this route
    // must never make by accident.
    const source = (runtimeSource === 'published' || (!known && publishedVersion > 0))
        ? 'published' : 'live';
    return {
        source,
        version: source === 'published' ? publishedVersion : 0,
        agentRev: Number(agent.rev) || 0,
        unpublishedChanges: publishedVersion > 0
            ? Math.max(0, (Number(agent.rev) || 1) - (Number(agent.published_rev) || 0))
            : 0,
    };
}

// ── The three preflights a model call shares ─────────────────────────
// Running the set and asking for a suggestion both spend inference on
// somebody's plan, and both need the same three answers first. They are one
// function each rather than one per route because the interesting half is the
// REFUSAL: each of these fails closed, and a second copy is where the second
// copy quietly stops doing that.

/**
 * The workspace this call is billed against.
 *
 * Not `.catch(() => null)`: this org id is what the plan ceiling is checked
 * AGAINST, and an org that could not be resolved would be checked as "no org
 * at all" — the widest possible reading of the question "how much of your plan
 * is left". `strict`: without that flag `resolveUserOrgIds` never throws and
 * the catch is a dead gate — an unreadable read arrived as an empty Set and
 * became "no org".
 *
 * @returns {Promise<{orgId: string|null, orgIdSet: Set<string>|null}|null>} null once answered.
 *          `orgId: null` after a SUCCESSFUL resolve means super admin; a failed
 *          resolve never gets here, so the two cannot be confused.
 */
async function resolveOrgOrRefuse(req) {
    try {
        const orgIds = await resolveUserOrgIds(req, { strict: true });
        return {
            orgIdSet: orgIds instanceof Set ? orgIds : null,
            orgId: orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null,
        };
    } catch (e) {
        log.error('[agents/tests] could not resolve the workspace:', /** @type {Error} */ (e).message);
        throw new HttpError(503, 'org_check_failed', 'Could not check your workspace right now. Try again.');
    }
}

/**
 * The plan ceiling the chat stream enforces, enforced here too.
 *
 * A check that could not RUN refuses: "I could not read the plan" is not
 * headroom.
 *
 * @returns {Promise<boolean>} false once answered.
 */
async function checkPlanOrRefuse(res, { orgId, userId }) {
    try {
        const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
        const limitError = await checkSubscriptionLimits(orgId, 'chat', userId);
        if (limitError) {
            res.status(429).json({ error: limitError, code: 'limit_reached' });
            return false;
        }
        return true;
    } catch (e) {
        log.error('[agents/tests] subscription check failed:', /** @type {Error} */ (e).message);
        throw new HttpError(503, 'limit_check_failed', 'Could not check your plan limits right now. Try again.');
    }
}

/**
 * @typedef {{ orgId: string | null,
 *   userId: string, what?: Readonly<Record<string, string>> }} ResolveFastTierOrRefuseArgs
 */
/**
 * The fast tier that reads an agent's answers — for grading, or for proposing
 * what a test should expect.
 *
 * No `fallback:` is passed on purpose: `resolveModelForTierName`'s fallback is
 * opt-in, and picking a model here would mean sending a privacy product's
 * answers to a provider this workspace never chose. Both ways of not having
 * one refuse, and they refuse DIFFERENTLY: "you have not configured one" is
 * something the user can fix, "we could not read your config" is something
 * they should retry. That difference is the whole reason this returns a code
 * per case instead of a null the caller has to interpret.
 *
 * @returns {Promise<string|null>} null once answered.
 * @param {ResolveFastTierOrRefuseArgs} param0
 */
async function resolveFastTierOrRefuse({ orgId, userId, what }) {
    /** @type {string | null} */
    let modelId = null;
    try {
        const { resolveModelForTierName } = require('../../core/llm/modelResolver');
        modelId = await resolveModelForTierName('fast', { userOrgId: orgId, userId });
    } catch (e) {
        log.error(`[agents/tests] ${what.label} model unreadable:`, /** @type {Error} */ (e).message);
        throw new HttpError(503, what.unreadableCode, what.unreadableError);
    }
    if (!modelId) {
        throw new HttpError(503, what.missingCode, what.missingError);
    }
    return modelId;
}

/** What `resolveFastTierOrRefuse` says when the grader is the missing one. */
const GRADER_MODEL = Object.freeze({
    label: 'grading',
    unreadableError: 'Could not look up which model grades these answers. Try again.',
    unreadableCode: 'grading_model_unavailable',
    // Without a grader every test comes back `error`. Spending N turns to say
    // so is worse than saying it now.
    missingError: 'No AI model is configured to grade these answers.',
    missingCode: 'no_grading_model',
});

/** And when it is the one that writes the suggestion. */
const SUGGEST_MODEL = Object.freeze({
    label: 'suggestion',
    unreadableError: 'Could not look up which model writes this suggestion. Try again.',
    unreadableCode: 'suggestion_model_unavailable',
    missingError: 'No AI model is configured to suggest what a test should expect.',
    missingCode: 'no_suggestion_model',
});

/**
 * One usage row per model call this file makes; `chatForcedTool` logs nothing
 * itself.
 *
 * Grading and suggesting are the two, and they carry DIFFERENT sources on
 * purpose: both spend somebody's inference on a test set, but one is "I ran my
 * tests" and the other is "I asked what to test", and a cost report that
 * cannot tell them apart cannot answer either question.
 */
async function logTestModelUsage({ userId, userOrgId, modelId, usage, startMs, agentName, source }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: agentName,
            agent_type: 'system',
            model: modelId,
            // Normalised by the adapter (providers/usageNormalizer.js): cache read/write,
            // the 5m/1h split and reasoning tokens ride along.
            ...usageLogFields(usage),
            source,
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn(`[agents/tests] failed to log ${source} usage:`, /** @type {Error} */ (e).message);
    }
}

/** The grading call's row. */
const logGradeUsage = (row) => logTestModelUsage({ ...row, agentName: 'agent-test-grade', source: 'agent_test_grade' });
/** The suggestion call's row — a different source, see above. */
const logSuggestUsage = (row) => logTestModelUsage({ ...row, agentName: 'agent-test-suggest', source: 'agent_test_suggest' });

/**
 * A positive whole number from the environment, or the default. Missing,
 * blank, non-numeric, fractional and <= 0 values all mean the default: 0 must
 * never become "send 0 tokens".
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Output-token cap of the grading call (AGENT_TEST_GRADE_MAX_TOKENS, default 1024). */
const gradeMaxTokens = () => envPositiveInt('AGENT_TEST_GRADE_MAX_TOKENS', 1024);
/** Output-token cap of the suggestion call (AGENT_TEST_SUGGEST_MAX_TOKENS, default 1024). */
const suggestMaxTokens = () => envPositiveInt('AGENT_TEST_SUGGEST_MAX_TOKENS', 1024);

module.exports = {
    envPositiveInt, gradeMaxTokens, suggestMaxTokens,
    versionInfo, resolveOrgOrRefuse, checkPlanOrRefuse, resolveFastTierOrRefuse,
    GRADER_MODEL, SUGGEST_MODEL, logGradeUsage, logSuggestUsage,
};
