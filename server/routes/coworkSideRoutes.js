// @typecheck strict
/**
 * The routes of /api/cowork that are about no single item (routes/cowork.js mounts them before its `/:id` routes, so
 * a word here is never read as an item id):
 *
 *   GET /needs-you          → everything waiting for the caller, in one list (usecases/coworkNeedsYou.mts)
 *   GET, PUT /shield/:orgId → the Privacy Shield on Cowork's prompt runs (./coworkShieldSettings.js)
 */

const { needsYou } = require('../usecases/coworkNeedsYou.mts');

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ needs?: typeof needsYou }} [overrides]
 */
function mountSideRoutes(router, { needs = needsYou } = {}) {
    router.get('/needs-you', async (req, res) => {
        const list = await needs(userIdOf(req));
        res.json({ needs: list, count: list.length });
    });
    router.use(require('./coworkShieldSettings'));
}

module.exports = { mountSideRoutes };
