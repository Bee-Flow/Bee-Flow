// @typecheck strict
/**
 * The plan half of /api/cowork (routes/cowork.js mounts it on its own router, behind the same requireAuth):
 *
 *   GET    /:id/plan          → the item's plan as its owner sees it: the steps, what it may do, why it may not run
 *                               if it may not, its fingerprint, and the plan that was approved
 *   PUT    /:id/plan          → name the automation the plan is made from (one the caller owns); approves nothing.
 *                               When Cowork can fix its wiring by itself, it does, and tries it (never approves it)
 *   POST   /:id/plan/fix-wiring → Cowork fixes the wiring of the plan that is not approved and tries it
 *                               (usecases/coworkPlanWiringRepair.mts); the card asks for it, or its owner does
 *   POST   /:id/plan/approve  → approve the plan the caller looked at (its fingerprint); a run executes that copy
 *   DELETE /:id/plan          → take the plan off; the item runs as a prompt or as its agent again
 *   POST   /:id/plan/try      → try the plan once without it changing or sending anything; answers 202 with the
 *                               try-out's id as soon as it started
 *   GET    /:id/plan/try/:tryId → how that try-out is going, step by step
 *   GET    /:id/runs/:runId/trace → the steps of a run that followed a plan, for the item's history
 *   GET    /:id/plan/independence → how independent the plan may be: the three levels, which are open, what each asks
 *   PUT    /:id/plan/independence → choose a level (usecases/coworkIndependence.mts says which may be chosen)
 *   GET    /:id/routine       → "make it routine": what the last good runs did, in names and counts
 *   GET    /:id/plan/try/:tryId/compare → the proof: that try-out next to the last run the AI made
 *   GET    /:id/plan/trust    → what each step has earned per recipient (usecases/coworkTrust.mts)
 *   PUT    /:id/plan/trust    → let one step and recipient go on its own, or ask again
 *
 * Ownership first (usecases/coworkItems.mts), the same rule as viewing and editing the item. What a plan is and when
 * it may be approved is the use case's (usecases/coworkPlan.mts) and the plan core's (core/cowork/plan); a try-out is
 * usecases/coworkPlanTry.mts, the steps of a run usecases/coworkRunTrace.mts.
 *
 * A try-out reads the owner's real data and runs the plan's AI steps for real, so starting one is limited per person,
 * and so is a fix of the wiring, which tries the fixed plan.
 */

const { validate } = require('../core/http/validate');
const { PlanAttachBody, PlanApproveBody, PlanTryParams, RunTraceParams, IndependenceBody, TrustBody, NoBody } = require('./coworkSchemas');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   plan: () => Pick<typeof import('../usecases/coworkPlan.mts'), 'planStateOf' | 'attachPlan' | 'approvePlan' | 'removePlan'>,
 *   tryOut: () => Pick<typeof import('../usecases/coworkPlanTry.mts'), 'startTry' | 'tryStateOf'>,
 *   trace: () => Pick<typeof import('../usecases/coworkRunTrace.mts'), 'runTraceOf'>,
 *   independence: () => Pick<typeof import('../usecases/coworkIndependence.mts'), 'independenceOf' | 'chooseIndependence'>,
 *   trust: () => Pick<typeof import('../usecases/coworkTrust.mts'), 'trustOf' | 'chooseTrust'>,
 *   routine: () => Pick<typeof import('../usecases/coworkRoutine.mts'), 'routineAdviceOf' | 'compareTry'>,
 *   wiring: () => Pick<typeof import('../usecases/coworkPlanWiringRepair.mts'), 'fixDraftWiring' | 'repairedState'>,
 *   tryLimit: import('express').RequestHandler<{ id: string }>,
 *   fixLimit: import('express').RequestHandler<{ id: string }>,
 *   spendLeft: (item: { id: string, userId: string, monthlyBudget?: number | null }) => Promise<void>,
 * }} PlanRouteDeps
 */

const TRIES_PER_MINUTE = 6;

/** The item loader, the use cases and the try-out limit; a test hands in its own. @returns {PlanRouteDeps} */
const defaults = () => ({
    loadItem: loadOwnedItem,
    plan: () => require('../usecases/coworkPlan.mts'),
    tryOut: () => require('../usecases/coworkPlanTry.mts'),
    trace: () => require('../usecases/coworkRunTrace.mts'),
    independence: () => require('../usecases/coworkIndependence.mts'),
    trust: () => require('../usecases/coworkTrust.mts'),
    routine: () => require('../usecases/coworkRoutine.mts'),
    wiring: () => require('../usecases/coworkPlanWiringRepair.mts'),
    tryLimit: perUserRateLimit({ windowMs: 60_000, max: TRIES_PER_MINUTE, name: 'cowork-plan-try' }),
    fixLimit: perUserRateLimit({ windowMs: 60_000, max: TRIES_PER_MINUTE, name: 'cowork-plan-fix-wiring' }),
    spendLeft: (item) => require('../core/cowork/spendGate.mts').assertSpendLeft(item),
});

/**
 * @param {import('express').Router} router
 * @param {Partial<PlanRouteDeps>} [overrides]
 */
function mountPlanRoutes(router, overrides = {}) {
    const { loadItem, plan, tryOut, trace, tryLimit, fixLimit, independence, trust, routine, wiring, spendLeft } = { ...defaults(), ...overrides };

    router.get('/:id/plan', async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().planStateOf(item));
    });

    router.put('/:id/plan', validate({ body: PlanAttachBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        const state = await plan().attachPlan({ item, automationId: req.body.automationId });
        // A plan named with its wiring wrong is fixed and tried by Cowork right away when it can be; never approved.
        res.json(state.wiringFixable ? await wiring().repairedState(item, state) : state);
    });

    router.post('/:id/plan/fix-wiring', fixLimit, validate({ body: NoBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await wiring().fixDraftWiring({ item }));
    });

    router.post('/:id/plan/approve', validate({ body: PlanApproveBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().approvePlan({ item, fingerprint: req.body.fingerprint }));
    });

    router.delete('/:id/plan', validate({ body: NoBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await plan().removePlan({ item }));
    });

    router.post('/:id/plan/try', tryLimit, validate({ body: NoBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        await spendLeft(item); // a try-out's AI counts against the budgets too (core/cowork/spendGate.mts)
        res.status(202).json(await tryOut().startTry({ item }));
    });

    router.get('/:id/plan/try/:tryId', validate({ params: PlanTryParams }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await tryOut().tryStateOf({ item, tryId: req.params.tryId }));
    });

    router.get('/:id/plan/independence', async (req, res) => {
        res.json(await independence().independenceOf(await loadItem(req.params.id, userIdOf(req))));
    });

    router.put('/:id/plan/independence', validate({ body: IndependenceBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await independence().chooseIndependence({ item, level: req.body.level }));
    });

    router.get('/:id/routine', async (req, res) => {
        res.json(await routine().routineAdviceOf(await loadItem(req.params.id, userIdOf(req))));
    });

    router.get('/:id/plan/try/:tryId/compare', validate({ params: PlanTryParams }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await routine().compareTry({ item, tryId: req.params.tryId }));
    });

    router.get('/:id/plan/trust', async (req, res) => {
        res.json(await trust().trustOf(await loadItem(req.params.id, userIdOf(req))));
    });

    router.put('/:id/plan/trust', validate({ body: TrustBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await trust().chooseTrust({ item, stepId: req.body.stepId, recipient: req.body.recipient, trusted: req.body.trusted }));
    });

    router.get('/:id/runs/:runId/trace', validate({ params: RunTraceParams }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await trace().runTraceOf({ item, runId: req.params.runId }));
    });
}

module.exports = { mountPlanRoutes };
