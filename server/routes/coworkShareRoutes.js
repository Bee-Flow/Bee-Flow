// @typecheck strict
/**
 * Sharing a cowork with a team (usecases/coworkShares.mts), under /api/cowork:
 *
 *   GET /:id/shares  → who the owner shared the item with, and as what (the owner only)
 *   PUT /:id/shares  → { shares: [{ userId, role: 'viewer' | 'approver' }] }: replace them (the owner only)
 *   GET /shared      → the items shared with the caller
 *   GET /shared/:id  → one of them, read only, with its last runs (someone it is shared with, or its owner)
 *
 * Mounted by ./coworkSideRoutes.js, before the item routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const SHARE_TEXT = 'shares is a list of { userId, role } with role viewer or approver.';
const ShareBody = z.object({
    shares: z.array(z.object({
        userId: z.string({ error: SHARE_TEXT }).min(1, { error: SHARE_TEXT }).max(200, { error: SHARE_TEXT }),
        role: z.enum(['viewer', 'approver'], { error: SHARE_TEXT }),
    }).strict(), { error: SHARE_TEXT }).max(50, { error: SHARE_TEXT }),
}).strict();
const SharedParams = z.object({ id: z.string().min(1).max(200) }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, shares?: () => Pick<typeof import('../usecases/coworkShares.mts'), 'sharesOf' | 'setSharesFor' | 'sharedWithMe' | 'sharedItemOf'> }} [overrides]
 */
function mountShareRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.shares ?? (() => require('../usecases/coworkShares.mts'));
    router.get('/shared', async (req, res) => {
        res.json({ items: await useCase().sharedWithMe(userIdOf(req)) });
    });
    router.get('/shared/:id', validate({ params: SharedParams }), async (req, res) => {
        res.json(await useCase().sharedItemOf(userIdOf(req), req.params.id));
    });
    router.get('/:id/shares', async (req, res) => {
        res.json({ shares: await useCase().sharesOf(await loadItem(req.params.id, userIdOf(req))) });
    });
    router.put('/:id/shares', validate({ body: ShareBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json({ shares: await useCase().setSharesFor({ item, shares: req.body.shares }) });
    });
}

module.exports = { mountShareRoutes };
