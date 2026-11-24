// @typecheck strict
/**
 * "Replay on last month" for a cowork's plan (usecases/coworkReplay.mts), under /api/cowork:
 *
 *   POST /:id/plan/replay            → replay the plan as it is now on the item's newest past runs ({} or { limit });
 *                                      answers 202 with the replay's id as soon as it started (the owner only)
 *   GET  /:id/plan/replay/:replayId  → how that replay is going: counts and a verdict per past run (the owner only)
 *
 * A replay touches no app: every read is answered from what the past run read, every write and send is simulated.
 * Its AI steps may still ask the model, so starting one is limited per person. Mounted by ./coworkSideRoutes.js,
 * before the item routes and behind routes/cowork.js's requireAuth and the read-only gate.
 */

const { validate } = require('../core/http/validate');
const { z, bodyOf, wholeNumber } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const LIMIT_TEXT = 'limit is the number of past runs to replay, from 1 to 50.';
const ReplayBody = bodyOf({ limit: wholeNumber(LIMIT_TEXT, { min: 1, max: 50 }).optional() }, 'A replay');
const ReplayParams = z.object({ id: z.string().min(1).max(200), replayId: z.string().min(1).max(200) }).strict();

const REPLAYS_PER_MINUTE = 3;

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem?: typeof loadOwnedItem,
 *   replay?: () => Pick<typeof import('../usecases/coworkReplay.mts'), 'startReplay' | 'replayStateOf'>,
 *   replayLimit?: import('express').RequestHandler<{ id: string }>,
 *   spendLeft?: (item: { id: string, userId: string, monthlyBudget?: number | null }) => Promise<void>,
 * }} ReplayRouteDeps
 */

/**
 * @param {import('express').Router} router
 * @param {ReplayRouteDeps} [overrides]
 */
function mountReplayRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.replay ?? (() => require('../usecases/coworkReplay.mts'));
    const spendLeft = overrides.spendLeft ?? ((/** @type {{ id: string, userId: string, monthlyBudget?: number | null }} */ i) => require('../core/cowork/spendGate.mts').assertSpendLeft(i));
    const replayLimit = overrides.replayLimit ?? perUserRateLimit({ windowMs: 60_000, max: REPLAYS_PER_MINUTE, name: 'cowork-plan-replay' });
    router.post('/:id/plan/replay', replayLimit, validate({ body: ReplayBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        await spendLeft(item); // a replay's AI counts against the budgets too (core/cowork/spendGate.mts)
        res.status(202).json(await useCase().startReplay({ item, ...(req.body.limit ? { limit: req.body.limit } : {}) }));
    });
    router.get('/:id/plan/replay/:replayId', validate({ params: ReplayParams }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await useCase().replayStateOf({ item, replayId: req.params.replayId }));
    });
}

module.exports = { mountReplayRoutes };
