// @typecheck
/**
 * Web pages — who uses one (W5 part B).
 *
 *   GET /:id/usage  →  { usage, unchecked, sources, complete }
 *
 * Feeds the same tab as every other kind: `shared/UsedByTab.jsx` via `hooks/useUsage.js`,
 * which already has `webpage → webpages` in `USAGE_KIND_PATH` with "W5" after it. The answer
 * therefore follows the shape of the knowledge base (`routes/knowledgeBases/usage.js`) and the
 * meeting note (`routes/transcriptions/usage.js`) literally: `usage` is the list, `unchecked`
 * the kinds that could not be answered. The client does not need to learn anything.
 *
 * ── OWNER-SCOPED, LIKE THE OTHER WEBPAGE ROUTES ─────────────────────
 *
 * `webpageStore.getWebpage(id, userId)` is owner-scoped in SQL; an org reader who may OPEN the
 * page gets a 404 here, just as with `routes/webpagesGrants.js` and `routes/webpagesAudience.js`.
 * That is not strictness for its own sake: this answer says in which Solution the page lies and
 * that a build conversation hangs on it. That is the owner's working arrangement, and a published
 * page is no invitation to read it out. The same 404 as every other route on this id, so that this
 * one cannot be used to discover which page ids exist.
 *
 * ── THREE FIELDS, THREE DIFFERENT VERDICTS ──────────────────────────
 *
 *   usage      what was found. Rows from someone else (a colleague's Solution) keep their kind and
 *              role and lose their name.
 *   unchecked  which kinds could NOT be answered. "I could not check the agents" is a different
 *              sentence from "no agent uses this page", and only on the second may someone delete.
 *              The delete gate must read this as IN USE — the same rule that
 *              `routes/transcriptions/noteActions.js` records.
 *   sources    per kind the state + `found`, in the shape that `routes/studio/attention.js` has set
 *              for "Needs attention". `unchecked` is the flat summary of that, so the existing client
 *              keeps working unchanged; `sources` is there for the screen that WANTS to say which
 *              sub-question fell through.
 *   complete   the licence to say "nothing uses this page".
 *
 * Today `complete` is always false, because it cannot be established which agents may open a page as
 * a tool — see the header of core/webpages/webpageUsage.js. That is the honest state, not a bug.
 *
 * Mounted from routes/webpages.js (`router.use(...)`), next to the grants and audience routers, and
 * therefore before `GET /:id`.
 *
 * ── NO QUERY ────────────────────────────────────────────────────────
 *
 * The route reads only the id from the path. A query key fell away silently: `?kind=agent` got back
 * ALL kinds under a 200, as if that filter existed. Now that is a 400 in one sentence, as in
 * `routes/transcriptions/usage.js`.
 */

const express = require('express');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');
// As a MODULE object, not destructured: that is what routes/webpagesGrants.js also does, and it is
// the reason that the test next to it can replace the scan without a database.
const webpageUsage = require('../core/webpages/webpageUsage');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z, onUnknownKeys } = require('../utils/zod');

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}, { error: onUnknownKeys('This usage list takes no parameters; it always covers every kind.') }).strict();

router.get('/:id/usage', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    // `usageForWebpage` catches each sub-question separately; if the lookup itself falls over,
    // then a 500 (the terminal handler) — never an empty `usage`, because that is the one sentence
    // that this route must not utter by accident.
    const userId = req.session.user.id;
    const wp = await webpageStore.getWebpage(req.params.id, userId);
    if (!wp) return res.status(404).json({ error: 'Webpage not found' });

    const { rows, partial, sources, complete } = await webpageUsage.usageForWebpage(wp);
    res.json({
        usage: webpageUsage.redactForeign(rows, userId),
        unchecked: partial,
        sources,
        complete,
    });
});

module.exports = router;
