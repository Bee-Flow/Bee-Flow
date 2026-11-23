// @typecheck strict
/**
 * The planner half of /api/cowork (routes/cowork.js mounts it on its own router, behind the same requireAuth):
 *
 *   POST /:id/plan/make → have Cowork draft the plan of this item from its brief (usecases/coworkPlanner.mts).
 *                         A refusal (the item already has a plan, no brief, no automations, no model) is an ordinary
 *                         answer with its status. Otherwise the answer is a stream: `progress` while the plan is
 *                         drafted, then `done` with the plan as its owner now sees it, or `error` with a sentence.
 *
 * Ownership first, the same rule as every other plan route. Making a plan spends a model's time, so it is limited
 * per person, and it stands behind the switch of the automation module: a plan is an automation.
 *
 * Nothing is approved here. The plan that comes out waits on its card to be tried and approved.
 */

const { validate } = require('../core/http/validate');
const { NoBody } = require('./coworkSchemas');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { openSse } = require('../core/http/sseHelpers');
const { requireModule } = require('../modules');
const log = require('../telemetry/log');
const { bestEffort, fallback } = require('../utils/bestEffort');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   planner: () => Pick<typeof import('../usecases/coworkPlanner.mts'), 'readyToPlan' | 'makePlan'>,
 *   plan: () => Pick<typeof import('../usecases/coworkPlan.mts'), 'planStateOf'>,
 *   orgOf: (req: import('express').Request, userId: string) => Promise<string | null>,
 *   makeLimit: import('express').RequestHandler<{ id: string }>,
 *   moduleGate: import('express').RequestHandler<{ id: string }>,
 * }} PlannerRouteDeps
 */

const MAKES_PER_MINUTE = 4;

/** @returns {PlannerRouteDeps} */
const defaults = () => ({
    loadItem: loadOwnedItem,
    planner: () => require('../usecases/coworkPlanner.mts'),
    plan: () => require('../usecases/coworkPlan.mts'),
    orgOf: (req, userId) => require('../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId })
        .catch((/** @type {unknown} */ e) => fallback('routes/coworkPlannerRoutes:orgOf', e, null)),
    makeLimit: perUserRateLimit({ windowMs: 60_000, max: MAKES_PER_MINUTE, name: 'cowork-plan-make' }),
    moduleGate: requireModule('automation'),
});

/**
 * What a failed making tells the page: the sentence of a refusal meant for the caller, else one fixed sentence (the
 * reason is in the log, not on the wire).
 * @param {unknown} err
 */
function failureOf(err) {
    const e = /** @type {{ status?: unknown, code?: unknown, message?: unknown }} */ (err && typeof err === 'object' ? err : {});
    if (typeof e.status === 'number' && e.status < 500 && typeof e.code === 'string' && typeof e.message === 'string') return { error: e.message, code: e.code };
    if (e.code === 'cowork_planner_timeout' && typeof e.message === 'string') return { error: e.message, code: e.code };
    return { error: 'The plan could not be made. Try again in a moment.', code: 'cowork_planner_failed' };
}

/**
 * @param {import('express').Router} router
 * @param {Partial<PlannerRouteDeps>} [overrides]
 */
function mountPlannerRoutes(router, overrides = {}) {
    const { loadItem, planner, plan, orgOf, makeLimit, moduleGate } = { ...defaults(), ...overrides };

    router.post('/:id/plan/make', moduleGate, makeLimit, validate({ body: NoBody }), async (req, res) => {
        const userId = userIdOf(req);
        const item = await loadItem(req.params.id, userId);
        const userOrgId = await orgOf(req, userId);
        await planner().readyToPlan({ item, userOrgId });

        // Drafting takes a while: a stream with a heartbeat, so no gateway in between gives up on a quiet request.
        const stream = openSse(res, { heartbeat: true, flush: true });
        try {
            const made = await planner().makePlan({
                item, session: req.session, userOrgId, signal: stream.signal,
                onProgress: (progress) => stream.send('progress', progress),
            });
            const state = await plan().planStateOf({ ...item, planAutomationId: made.automationId });
            stream.send('done', { summary: made.summary, state });
        } catch (err) {
            const failure = failureOf(err);
            // A caller that left gets no answer; why the making ended is still worth a line.
            if (stream.isGone()) bestEffort('routes/coworkPlannerRoutes:make', err);
            else {
                if (failure.code === 'cowork_planner_failed') log.error(`[CoworkPlanner] ${item.id}: ${/** @type {Error} */ (err)?.message}`);
                stream.send('error', failure);
            }
        } finally {
            stream.end();
        }
    });
}

module.exports = { mountPlannerRoutes };
