// @typecheck strict
/**
 * The daily Cowork e-mail of the caller (jobs/coworkDailyMail.mts sends it):
 *
 *   GET /daily-mail  → { enabled, timeZone, available }   available: the instance can send mail at all
 *   PUT /daily-mail  { enabled, timeZone } → the same      the caller's own setting, nobody else's
 *
 * Mounted under /api/cowork by ./coworkSideRoutes.js, behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z, flag } = require('../core/http/schemaParts');
const { sessionUser } = require('../core/http/sessionUser');

const ZONE_TEXT = 'timeZone is a time zone such as Europe/Amsterdam.';

/** A time zone this runtime knows (the mail's morning is computed in it). @param {string} zone */
function isTimeZone(zone) {
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

const DailyMailBody = z.object({
    enabled: flag('enabled is true or false.'),
    timeZone: z.string({ error: ZONE_TEXT }).min(1, { error: ZONE_TEXT }).max(64, { error: ZONE_TEXT }).refine(isTimeZone, { error: ZONE_TEXT }),
}).strict();

/**
 * @typedef {{ enabled: boolean, timeZone: string }} Setting
 * @typedef {{
 *   store?: { getSetting: (userId: string) => Promise<Setting>, setSetting: (userId: string, s: Setting) => Promise<Setting> },
 *   mailAvailable?: () => Promise<boolean>,
 * }} DailyMailRouteDeps
 */

/** @returns {Required<DailyMailRouteDeps>} */
const defaults = () => ({
    store: require('../stores/coworkDailyMail.mts').coworkDailyMailStore(),
    mailAvailable: async () => (await require('../utils/emailTransport').getServiceEmailConfig()).configured,
});

/**
 * @param {import('express').Router} router
 * @param {DailyMailRouteDeps} [overrides]
 */
function mountDailyMailRoutes(router, overrides = {}) {
    const deps = () => ({ ...defaults(), ...overrides });
    router.get('/daily-mail', async (req, res) => {
        const { store, mailAvailable } = deps();
        res.json({ ...(await store.getSetting(sessionUser(req).id)), available: await mailAvailable() });
    });
    router.put('/daily-mail', validate({ body: DailyMailBody }), async (req, res) => {
        const { store, mailAvailable } = deps();
        const saved = await store.setSetting(sessionUser(req).id, { enabled: req.body.enabled === true, timeZone: req.body.timeZone });
        res.json({ ...saved, available: await mailAvailable() });
    });
}

module.exports = { mountDailyMailRoutes };
