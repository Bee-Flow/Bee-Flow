// @typecheck strict
/**
 * Handing a cowork to a colleague (usecases/coworkHandOver.mts), under /api/cowork:
 *
 *   GET  /:id/hand-over/colleagues → who it can go to: the owner's organisation, id and name only
 *   POST /:id/hand-over            → { toUserId }: the colleague gets a new, paused item with the plan to approve; this
 *                                    one goes, with its runs. Answers the new item's id.
 *
 * The owner's own item only (usecases/coworkItems.mts), like every item route.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const USER_TEXT = 'toUserId is the id of a colleague.';
const HandOverBody = z.object({ toUserId: z.string({ error: USER_TEXT }).min(1, { error: USER_TEXT }).max(200, { error: USER_TEXT }) }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, handOver?: () => Pick<typeof import('../usecases/coworkHandOver.mts'), 'colleaguesOf' | 'handOver'> }} [overrides]
 */
function mountHandOverRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.handOver ?? (() => require('../usecases/coworkHandOver.mts'));
    router.get('/:id/hand-over/colleagues', async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json({ colleagues: await useCase().colleaguesOf(item) });
    });
    router.post('/:id/hand-over', validate({ body: HandOverBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await useCase().handOver({ item, toUserId: req.body.toUserId }));
    });
}

module.exports = { mountHandOverRoutes };
