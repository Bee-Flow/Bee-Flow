/**
 * Usage aggregate for the Apps directory (APPS-08) — READ-ONLY, org-scoped.
 *
 * One endpoint, mounted at /api/studio-apps behind the same module +
 * capability gates as the CRUD router:
 *
 *   GET /usage-counts?window=month
 *     → { window, unit: 'action_runs', counts: { [appId]: number } }
 *
 * Its own file on purpose. The number is a READ over `ai_usage_log` rows that
 * routes/studioAppsRun.js already writes; nothing here touches the write path,
 * and keeping it out of studioApps.js means the directory's CRUD router and
 * this aggregate can move independently.
 *
 * WHAT THE NUMBER IS. It counts ACTION RUNS — presses that dispatched an app
 * action through the run_automation bridge — in the given window. It is NOT an
 * opens counter: an app that only writes records along another path counts 0
 * while it runs every day, and there is no source in the product today that
 * measures openings. That is why the payload names its own `unit`: a caller
 * that renders this as "214x" would be promising a measurement nobody took.
 * The honest label is "N actions this month".
 *
 * WHO SEES WHAT. The rows carry the OWNER's user_id (an action run acts as the
 * owner even when a colleague presses the button), so filtering by the viewer
 * would answer 0 for everyone but the builder. The scoping is therefore the
 * id list: getAccessibleStudioApps — the very predicate the directory listing
 * uses — decides which apps the caller may see, and only those ids are asked
 * about and answered. An app the caller may not see is absent from `counts`,
 * not zero, so this route never confirms that an id exists.
 *
 * Mount ORDER matters: this router must sit BEFORE routes/studioApps.js in
 * server/index.js, or that router's GET /:id swallows /usage-counts and
 * answers 404 for an app named "usage-counts". studioAppUsage.test.js pins it.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const studioAppStore = require('../stores/studioAppStore');
const usageStore = require('../stores/usageStore');
const { requireAuth } = require('../auth/permissions');
const { resolveAudienceContext } = require('../auth/audience');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// The window vocabulary lives with the query (usageStore.RUN_COUNT_WINDOWS) so
// there is exactly one closed list; the route only decides what an unknown key
// does. A silent fallback to 'month' would let a client believe it asked for a
// week and got one.
function isKnownWindow(w) {
    return Object.prototype.hasOwnProperty.call(usageStore.RUN_COUNT_WINDOWS, w);
}

// The same promise for the NAME of the key: `?windw=week` was dropped, and the
// answer was this month's counts, labelled `window: 'month'` to a caller who
// had asked for a week. The key set is strict; the VALUE stays with the check
// below, whose 400 carries `code: 'invalid_window'` and the `supported` list.
const UsageQuery = z.object({
    window: z.string({ invalid_type_error: 'window is one word, e.g. "month".' }).optional(),
}).strict();

router.get('/usage-counts', requireAuth, validate({ query: UsageQuery }), async (req, res) => {
    const window = req.query.window === undefined ? 'month' : String(req.query.window);
    if (!isKnownWindow(window)) {
        return res.status(400).json({
            error: `Unsupported window '${window}'`,
            code: 'invalid_window',
            supported: Object.keys(usageStore.RUN_COUNT_WINDOWS),
        });
    }
    try {
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        // resolveUserOrgIds returns null for a super admin; the store predicates
        // want a plain array (same collapse as studioApps.js audienceFor).
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        const apps = await studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArr);
        const counts = await usageStore.getStudioAppRunCounts(apps.map(a => a.id), { window });
        res.json({
            window,
            // Names the measurement in the payload itself — see the docblock.
            unit: 'action_runs',
            counts: Object.fromEntries(counts),
        });
    } catch (err) {
        log.error('[StudioAppUsage] usage-counts failed:', err.message);
        res.status(500).json({ error: 'Failed to load app usage' });
    }
});

module.exports = router;
