// @typecheck strict
/**
 * The plan half of /api/cowork (routes/cowork.js mounts it on its own router, behind the same requireAuth):
 *
 *   GET    /:id/plan          → the item's plan as its owner sees it: the steps, what it may do, why it may not run
 *                               if it may not, its fingerprint, and the plan that was approved
 *   PUT    /:id/plan          → name the automation the plan is made from (one the caller owns); approves nothing
 *   POST   /:id/plan/approve  → approve the plan the caller looked at (its fingerprint); a run executes that copy
 *   DELETE /:id/plan          → take the plan off; the item runs as a prompt or as its agent again
 *
 * Ownership first (usecases/coworkItems.mts), the same rule as viewing and editing the item. What a plan is and when
 * it may be approved is the use case's (usecases/coworkPlan.mts) and the plan core's (core/cowork/plan).
 */

const { validate } = require('../core/http/validate');
const { PlanAttachBody, PlanApproveBody, NoBody } = require('./coworkSchemas');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   plan: () => Pick<typeof import('../usecases/coworkPlan.mts'), 'planStateOf' | 'attachPlan' | 'approvePlan' | 'removePlan'>,
 * }} PlanRouteDeps
 */

/** The item loader and the use case; a test hands in its own. @type {PlanRouteDeps} */
const DEFAULTS = { loadItem: loadOwnedItem, plan: () => require('../usecases/coworkPlan.mts') };

/**
 * @param {import('express').Router} router
 * @param {Partial<PlanRouteDeps>} [overrides]
 */
function mountPlanRoutes(router, overrides = {}) {
    const { loadItem, plan } = { ...DEFAULTS, ...overrides };

    router.get('/:id/plan', async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().planStateOf(item));
    });

    router.put('/:id/plan', validate({ body: PlanAttachBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().attachPlan({ item, automationId: req.body.automationId }));
    });

    router.post('/:id/plan/approve', validate({ body: PlanApproveBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().approvePlan({ item, fingerprint: req.body.fingerprint }));
    });

    router.delete('/:id/plan', validate({ body: NoBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().removePlan({ item }));
    });
}

module.exports = { mountPlanRoutes };
