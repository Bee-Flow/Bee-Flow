// @typecheck strict
/**
 * What a cowork remembers from one run to the next (usecases/coworkMemory.mts), under /api/cowork:
 *
 *   GET  /:id/memory          → { memories: [{ id, text, at }] } (the owner only)
 *   POST /:id/memory/clear    → { cleared: [ids] }: the next run starts fresh
 *   POST /:id/memory/restore  → { restored: n }: Undo of a clear, for the ids it cleared
 *
 * Mounted by ./coworkSideRoutes.js, before the item routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { bodyOf, idList } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const ClearBody = bodyOf({}, 'Clearing what a cowork remembers');
const IDS_TEXT = 'ids is the list of memory ids a clear returned, at most 100.';
const RestoreBody = bodyOf({ ids: idList(IDS_TEXT, 100) }, 'Restoring what a cowork remembered');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, memory?: () => Pick<typeof import('../usecases/coworkMemory.mts'), 'memoriesOf' | 'clearMemories' | 'restoreMemories'> }} [overrides]
 */
function mountMemoryRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.memory ?? (() => require('../usecases/coworkMemory.mts'));
    router.get('/:id/memory', async (req, res) => {
        res.json(await useCase().memoriesOf(await loadItem(req.params.id, userIdOf(req))));
    });
    router.post('/:id/memory/clear', validate({ body: ClearBody }), async (req, res) => {
        res.json(await useCase().clearMemories(await loadItem(req.params.id, userIdOf(req))));
    });
    router.post('/:id/memory/restore', validate({ body: RestoreBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await useCase().restoreMemories(item, req.body.ids ?? []));
    });
}

module.exports = { mountMemoryRoutes };
