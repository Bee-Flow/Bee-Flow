/**
 * Maintenance / deployment window routes.
 *
 *   GET    /                 → the window in force (authenticated users)
 *   POST   /announce         → open a window   (deploy pipeline, token auth)
 *   POST   /clear            → close it early  (deploy pipeline, token auth)
 *
 * The write paths are called by CI, not by a logged-in human, so they carry a
 * shared-secret token rather than a session. The token lives in
 * MAINTENANCE_ANNOUNCE_TOKEN; with it unset the write paths are disabled
 * outright (503) rather than left open — an unauthenticated "the server is
 * going down" broadcast is a griefing tool.
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const maintenanceWindow = require('../core/entitlements/maintenanceWindow');
const { APP_BUILD_SHA } = require('../utils/buildInfo');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What the pipeline may send ──────────────────────────────────────
//
// The callers are deploy pipelines (Bee Flow's own lives in a private repo):
// `{ etaSeconds, reason, ref }` to /announce and nothing to /clear. The body
// is `.strict()` and its text fields are text, because what they carry ends
// up in a banner in front of EVERY signed-in user:
//
//   - `reason: {}` went through String() and put "[object Object]" there;
//   - a misspelled `reson` or `rfe` was dropped, so the banner lost its
//     reason, or the window its build ref — the thing the client compares.
//
// `etaSeconds` keeps the core's contract (maintenanceWindow._clampEta):
// a number, or a numeric string — "a JSON body legitimately carries '180'" —
// clamped to 10..3600 there. Anything else was already a 400; it is now the
// schema's, in a sentence. And a failure while storing the window is a
// generic 500 through the terminal handler, instead of echoing its message.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the announcement as a JSON object.' }).strict(),
);

const ETA_TEXT = 'etaSeconds is the expected outage in seconds, as a number.';
const AnnounceBody = bodyOf({
    // The union's errorMap words a value of neither type; a string of the
    // right type but not a number fails inside its own branch, so that
    // branch carries the same sentence.
    etaSeconds: z.union([
        z.number(),
        z.string().refine((v) => v.trim() !== '' && Number.isFinite(Number(v)), ETA_TEXT),
    ], { errorMap: () => ({ message: ETA_TEXT }) }),
    reason: worded('reason is the text the banner shows.').optional(),
    ref: worded('ref is the build the rollout brings, as text.').optional(),
});

/** Clear takes nothing: there is one window, and this closes it. */
const NoBody = bodyOf({});

/**
 * Constant-time bearer-token check.
 *
 * timingSafeEqual THROWS on a length mismatch, so the lengths are compared
 * first — same shape as the storageProxy token gate.
 */
function _authorized(req) {
    const expected = process.env.MAINTENANCE_ANNOUNCE_TOKEN || '';
    if (!expected) return false;

    const header = req.get('authorization') || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided) return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _requireDeployToken(req, res, next) {
    if (!process.env.MAINTENANCE_ANNOUNCE_TOKEN) {
        return res.status(503).json({ error: 'maintenance_announce_disabled' });
    }
    if (!_authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    next();
}

// GET / — what the banner polls.
//
// Returns appVersion alongside the window so the client can tell "the ETA
// elapsed" (a guess) from "a new build is actually serving me" (the truth).
//
// The stamp comes from utils/buildInfo — the SAME value /api/health/schema
// exposes as `build` — and not from a raw env read: buildInfo falls back to
// 'dev' instead of '', so version-change detection keeps a usable baseline on
// local/self-host builds without CI injection too.
router.get('/', async (req, res) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const window = await maintenanceWindow.getActiveWindow();
    res.json({ maintenance: window, appVersion: APP_BUILD_SHA });
});

// POST /announce — { etaSeconds, reason?, ref? }
router.post('/announce', _requireDeployToken, validate({ body: AnnounceBody }), async (req, res) => {
    const { etaSeconds, reason, ref } = req.body;
    const window = await maintenanceWindow.announce({ etaSeconds, reason, ref });
    res.json({ success: true, maintenance: window });
});

// POST /clear — rollout finished ahead of its ETA.
router.post('/clear', _requireDeployToken, validate({ body: NoBody }), async (req, res) => {
    await maintenanceWindow.clear();
    res.json({ success: true });
});

module.exports = router;
