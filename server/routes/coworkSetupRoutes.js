// @typecheck strict
/**
 * The set-up half of /api/cowork (routes/cowork.js mounts it on its own router, behind the same requireAuth):
 *
 *   PUT /:id/setup → `{ mode: 'ai' }`: let the AI work it out every run. The task's steps come off and it stops
 *                    waiting for them. `{ mode: 'steps' }` is its Undo: the steps it had, the approval they had, and
 *                    where its set-up stood all come back (usecases/coworkSetup.mts). Answers `{ setup }`.
 *
 * Ownership first (usecases/coworkItems.mts), the same rule as every other route of an item.
 */

const { validate } = require('../core/http/validate');
const { SetupModeBody } = require('./coworkSchemas');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   setup: () => Pick<typeof import('../usecases/coworkSetup.mts'), 'chooseMode'>,
 * }} SetupRouteDeps
 */

/** @returns {SetupRouteDeps} */
const defaults = () => ({ loadItem: loadOwnedItem, setup: () => require('../usecases/coworkSetup.mts') });

/**
 * @param {import('express').Router} router
 * @param {Partial<SetupRouteDeps>} [overrides]
 */
function mountSetupRoutes(router, overrides = {}) {
    const { loadItem, setup } = { ...defaults(), ...overrides };

    router.put('/:id/setup', validate({ body: SetupModeBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json({ setup: await setup().chooseMode({ item, mode: req.body.mode }) });
    });
}

module.exports = { mountSetupRoutes };
