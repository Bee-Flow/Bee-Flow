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
 *   GET, PUT /policy/:orgId, GET /policy/:orgId/audit → the organisation's Cowork policy (./coworkPolicyRoutes.js)
 *
 * In front of all of them, and of every item route after them: while the caller's organisation has made Cowork
 * read-only, nothing that changes a cowork is accepted (423). Its administrators' policy and the shield stay open, so the
 * switch can be turned off again; so does the caller's own daily e-mail.
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

const STAYS_OPEN = ['/policy/', '/shield/', '/daily-mail'];

/**
 * Refuse every change while the caller's organisation has made Cowork read-only.
 * @param {((userId: string) => Promise<{ readOnly: boolean }>) | undefined} policyOf
 * @returns {import('express').RequestHandler}
 */
function readOnlyGate(policyOf) {
    return async (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD' || STAYS_OPEN.some((p) => req.path.startsWith(p))) return next();
        const user = req.session?.user;
        if (!user?.id) return next();
        const of = policyOf ?? ((/** @type {string} */ id) => require('../core/entitlements/coworkPolicy.mts').policyOfOwner(id));
        const policy = await of(user.id);
        // A policy that could not be read stops every run (core/cowork/coworkRunner.js); a change is let through, as
        // a change sends nothing, and the switch an administrator set is what this gate holds.
        if (!policy.readOnly || /** @type {{ unreadable?: boolean }} */ (policy).unreadable) return next();
        return res.status(423).json({ error: 'Your organisation has made Cowork read-only: nothing can be created or changed until an administrator switches that off.', code: 'cowork_read_only' });
    };
}

/**
 * @param {import('express').Router} router
 * @param {{ needs?: typeof needsYou, home?: typeof homeOf, dailyMail?: import('./coworkDailyMailRoutes').DailyMailRouteDeps, policyOf?: (userId: string) => Promise<{ readOnly: boolean }> }} [overrides]
 */
function mountSideRoutes(router, { needs = needsYou, home = homeOf, dailyMail = {}, policyOf = undefined } = {}) {
    router.use(readOnlyGate(policyOf));
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
    router.use(require('./coworkPolicyRoutes'));
}

module.exports = { mountSideRoutes };
