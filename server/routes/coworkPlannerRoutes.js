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
 * Nothing is approved here. The plan that comes out waits on its card to be tried and approved. A making that fails,
 * or whose caller leaves, never turns a task that waits for its steps into one the AI does: the task keeps waiting and
 * says why under "Needs you" (usecases/coworkSetup.mts).
 */

const { validate } = require('../core/http/validate');
const { z, bodyOf } = require('../core/http/schemaParts');

// POST /:id/plan/make: nothing, or { fromRuns: true } to make the item's past runs routine.
const PlanMakeBody = bodyOf({ fromRuns: z.boolean({ error: 'fromRuns is true or false.' }).optional() }, 'Making a plan');
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
 *   routine: () => Pick<typeof import('../usecases/coworkRoutine.mts'), 'hintsFor'>,
 *   orgOf: (req: import('express').Request, userId: string) => Promise<string | null>,
 *   makeLimit: import('express').RequestHandler<{ id: string }>,
 *   moduleGate: import('express').RequestHandler<{ id: string }>,
 *   record: typeof import('../usecases/coworkAudit.mts').recordCowork,
 *   spendLeft: (item: { id: string, userId: string, monthlyBudget?: number | null }) => Promise<void>,
 *   setup: () => Pick<typeof import('../usecases/coworkSetup.mts'), 'setupStarted' | 'setupFailed'>,
 * }} PlannerRouteDeps
 */

const MAKES_PER_MINUTE = 4;

/** @returns {PlannerRouteDeps} */
const defaults = () => ({
    loadItem: loadOwnedItem,
    planner: () => require('../usecases/coworkPlanner.mts'),
    routine: () => require('../usecases/coworkRoutine.mts'),
    plan: () => require('../usecases/coworkPlan.mts'),
    orgOf: (req, userId) => require('../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId })
        .catch((/** @type {unknown} */ e) => fallback('routes/coworkPlannerRoutes:orgOf', e, null)),
    makeLimit: perUserRateLimit({ windowMs: 60_000, max: MAKES_PER_MINUTE, name: 'cowork-plan-make' }),
    moduleGate: requireModule('automation'),
    record: (...a) => require('../usecases/coworkAudit.mts').recordCowork(...a),
    spendLeft: (item) => require('../core/cowork/spendGate.mts').assertSpendLeft(item),
    setup: () => require('../usecases/coworkSetup.mts'),
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
    const { loadItem, planner, plan, routine, orgOf, makeLimit, moduleGate, record, spendLeft, setup } = { ...defaults(), ...overrides };

    router.post('/:id/plan/make', moduleGate, makeLimit, validate({ body: PlanMakeBody }), async (req, res) => {
        const userId = userIdOf(req);
        const item = await loadItem(req.params.id, userId);
        const userOrgId = await orgOf(req, userId);
        let prepared;
        try {
            prepared = await planner().readyToPlan({ item, userOrgId });
            await spendLeft(item); // drafting a plan is AI too: it counts against the budgets (core/cowork/spendGate.mts)
        } catch (err) {
            // A task that waits for its steps keeps waiting, and says why (usecases/coworkSetup.mts): never the AI by itself.
            await setup().setupFailed({ item, err });
            throw err;
        }
        await setup().setupStarted(item);
        // "Make it routine": the planner is told what the item's past runs did (usecases/coworkRoutine.mts).
        const hints = req.body?.fromRuns === true ? await routine().hintsFor(item) : null;

        // Drafting takes a while: a stream with a heartbeat, so no gateway in between gives up on a quiet request.
        const stream = openSse(res, { heartbeat: true, flush: true });
        try {
            const made = await planner().makePlan({
                item, prepared, session: req.session, userOrgId, signal: stream.signal, hints,
                onProgress: (progress) => stream.send('progress', progress),
            });
            // The trail (usecases/coworkAudit.mts): written here, once the plan exists.
            void record('cowork.plan_made', item.id, { userId, organizationId: userOrgId }, { automationId: made.automationId });
            const state = await plan().planStateOf({ ...item, planAutomationId: made.automationId });
            stream.send('done', { summary: made.summary, state });
        } catch (err) {
            const failure = failureOf(err);
            await setup().setupFailed({ item, err, left: stream.isGone() }).catch((/** @type {unknown} */ e) => bestEffort('routes/coworkPlannerRoutes:setupFailed', e));
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
