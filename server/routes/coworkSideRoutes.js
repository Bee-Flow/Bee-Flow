// @typecheck strict
/**
 * The routes of /api/cowork that are about no single item (routes/cowork.js mounts them before its `/:id` routes, so
 * a word here is never read as an item id):
 *
 *   GET /needs-you          → everything waiting for the caller, in one list (usecases/coworkNeedsYou.mts)
 *   GET, PUT /daily-mail    → the caller's daily e-mail of that list (./coworkDailyMailRoutes.js)
 *   GET /home?from=&to=     → Cowork's home: how each item works, the caller's day, the AI cost this month
 *                             (usecases/coworkHome.mts; from and to are where the caller's day starts and ends)
 *   GET, PUT /shield/:orgId → the Privacy Shield on Cowork's prompt runs (./coworkShieldSettings.js)
 */

const { needsYou } = require('../usecases/coworkNeedsYou.mts');
const { homeOf } = require('../usecases/coworkHome.mts');
const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');

const DAY_TEXT = 'from and to are the start and end of your day, as ISO times, at most two days apart.';
const DAY_MS = 86_400_000;
const isoTime = z.iso.datetime({ offset: true, error: DAY_TEXT });
const HomeQuery = z.object({ from: isoTime, to: isoTime }).strict()
    .refine((q) => { const span = Date.parse(q.to) - Date.parse(q.from); return span > 0 && span <= 2 * DAY_MS; }, { error: DAY_TEXT });

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ needs?: typeof needsYou, home?: typeof homeOf, dailyMail?: import('./coworkDailyMailRoutes').DailyMailRouteDeps }} [overrides]
 */
function mountSideRoutes(router, { needs = needsYou, home = homeOf, dailyMail = {} } = {}) {
    router.get('/needs-you', async (req, res) => {
        const list = await needs(userIdOf(req));
        res.json({ needs: list, count: list.length });
    });
    router.get('/home', validate({ query: HomeQuery }), async (req, res) => {
        const day = { from: String(req.query.from), to: String(req.query.to) };
        res.json(await home(userIdOf(req), day));
    });
    require('./coworkDailyMailRoutes').mountDailyMailRoutes(router, dailyMail);
    router.use(require('./coworkShieldSettings'));
}

module.exports = { mountSideRoutes };
