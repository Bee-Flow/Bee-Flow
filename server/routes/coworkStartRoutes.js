// @typecheck strict
/**
 * How a cowork starts (usecases/coworkStart.mts), under /api/cowork:
 *
 *   GET /:id/start → the clock, or the event it starts on (after another cowork, a call to its address, a change in a
 *                    table, a new file in a folder); a new mail is the edit form's
 *   PUT /:id/start → choose one. For a webhook the answer carries its new address, once.
 *
 * The owner's own item only (usecases/coworkItems.mts), like every item route.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const ID_TEXT = 'An id of 1 to 200 characters.';
const FOLDER_TEXT = 'inFolder is a folder path that starts with "/", at most 500 characters.';
const id = z.string({ error: ID_TEXT }).min(1, { error: ID_TEXT }).max(200, { error: ID_TEXT });
const StartBody = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('schedule') }).strict(),
    z.object({ kind: z.literal('after_cowork'), scheduleId: id }).strict(),
    z.object({ kind: z.literal('webhook') }).strict(),
    z.object({ kind: z.literal('row'), datatableId: id }).strict(),
    z.object({ kind: z.literal('file'), inFolder: z.string({ error: FOLDER_TEXT }).min(1, { error: FOLDER_TEXT }).max(500, { error: FOLDER_TEXT }).refine((p) => p.startsWith('/'), { error: FOLDER_TEXT }) }).strict(),
], { error: 'kind is schedule, after_cowork, webhook, row or file.' });

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, start?: () => Pick<typeof import('../usecases/coworkStart.mts'), 'startOf' | 'chooseStart'> }} [overrides]
 */
function mountStartRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.start ?? (() => require('../usecases/coworkStart.mts'));
    router.get('/:id/start', async (req, res) => {
        res.json(await useCase().startOf(await loadItem(req.params.id, userIdOf(req))));
    });
    router.put('/:id/start', validate({ body: StartBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await useCase().chooseStart({ item, choice: req.body }));
    });
}

module.exports = { mountStartRoutes };
