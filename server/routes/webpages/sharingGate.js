/**
 * Webpage sharing: the licence line (enterprise split, 2026-10).
 *
 * Building, previewing and keeping your own webpages is Community
 * (`webpages`). Sharing a page with anyone else is the Enterprise capability
 * `webpage_sharing`: publishing it to the organisation or to groups, public
 * share links, and making it public at its address. This file answers the one
 * question each sharing route has to ask first, "does this request WIDEN who
 * can see the page?", and runs the real requireCapability middleware only
 * when it does.
 *
 * The house rule it implements, the same one routes/automation/sharing.js and
 * routes/datatables/sharing.js follow:
 *
 *   - only NEW sharing or WIDENING is refused: a first publish, another group,
 *     groups becoming the whole organisation, a new public link, a later or
 *     removed expiry, more public columns, a weaker way to protect a link;
 *   - what exists keeps working: a page that is already published stays
 *     published and can be republished for the audience it has, and an
 *     existing link can be refreshed;
 *   - taking access away is never gated: unpublishing, dropping groups,
 *     revoking a link, turning public off, an earlier expiry.
 *
 * A refusal is the standard 403 body (`feature_locked` with `required`, or
 * `feature_disabled` when the plan has it but the organisation did not switch
 * it on), and it comes before anything is written.
 *
 * `gate.requireSharing` is the one seam: the routes call it through this
 * object, so a test replaces it the way the route tests already replace store
 * functions.
 */

'use strict';

const CAPABILITY = 'webpage_sharing';

let middleware = null;

const gate = {
    CAPABILITY,

    /** The real requireCapability('webpage_sharing') middleware, built on first use. */
    requireSharing(req, res, next) {
        if (!middleware) middleware = require('../../core/entitlements/entitlements').requireCapability(CAPABILITY);
        return middleware(req, res, next);
    },

    /**
     * Run the gate inside a handler. Resolves true when it let the request
     * through, false when it has already answered (the 403 or the 503), so a
     * route writes `if (widens && !(await gate.allow(req, res))) return;`
     * before it touches anything.
     */
    allow(req, res) {
        return new Promise((resolve, reject) => {
            let passed = false;
            const next = (err) => {
                passed = true;
                if (err) reject(err); else resolve(true);
            };
            Promise.resolve(gate.requireSharing(req, res, next))
                .then(() => { if (!passed) resolve(false); }, reject);
        });
    },

    publishWidens,
    expiryExtends,
    publicRequestWidens,
};

const idsOf = (list) => (Array.isArray(list) ? list.filter(Boolean).map(String) : []);

/**
 * Does PATCH /:id/publish hand the page to anyone who could not see it?
 *
 * The audience model is audience.js canSeePublished: published with an EMPTY
 * group list is the WHOLE organisation, published with groups is those
 * groups. So:
 *   - unpublishing never widens;
 *   - publishing a page that is not published widens;
 *   - on a published page, an omitted `sharedGroups` keeps the audience (a
 *     republish of what is there), an empty list widens unless the page was
 *     already org-wide, and a group list widens when it names a group the
 *     page did not have. Org-wide to some groups NARROWS.
 */
function publishWidens(webpage, { isPublished, sharedGroups } = {}) {
    if (!isPublished) return false;
    if (!webpage || !webpage.isPublished) return true;
    if (sharedGroups === undefined) return false;
    const before = idsOf(webpage.sharedGroups);
    const after = idsOf(sharedGroups);
    if (after.length === 0) return before.length > 0;
    if (before.length === 0) return false;
    return after.some((g) => !before.includes(g));
}

const timeOf = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
};

/**
 * Does moving a link's expiry from `current` to `next` keep it open longer?
 * Null means "never expires". A later date, or dropping the date, extends. An
 * earlier date narrows, and so does giving a date to a link that had none.
 * An expired link counts too: moving its date into the future reopens it.
 */
function expiryExtends(current, next) {
    const now = timeOf(current);
    const then = timeOf(next);
    if (now === null) return false;
    if (then === null) return true;
    return then > now;
}

// How strictly a public link is protected. A move DOWN this list lets more
// people in: from a list of addresses to anyone with a password, or from a
// password to anyone with the link.
const ACCESS_RANK = Object.freeze({ unlisted: 0, password: 1, email: 2 });

/**
 * Does PUT /:id/audience/public with `on: true` widen what is public?
 *
 * `existing` is the page's LIVE canonical share (null when the page is not
 * public), `currentTables` the bridge grants as stored, `body` the request.
 * Turning public on widens. On a page that is already public, the request
 * widens when it:
 *   - lets out a column that was not public before (applyColumnChoice is the
 *     same function the route applies, so the comparison is with what would
 *     be saved);
 *   - keeps the address open longer (expiryExtends);
 *   - protects it more weakly (ACCESS_RANK), or adds an address to an e-mail
 *     gated link.
 * A new password on a password link, an earlier expiry, fewer columns or
 * fewer addresses are not widening, even when they replace the link.
 */
function publicRequestWidens({ existing, currentTables, body = {} }) {
    if (!existing) return true;
    const audience = require('../../core/webpages/webpagePublicAudience');

    const before = new Map((Array.isArray(currentTables) ? currentTables : [])
        .map((t) => [t?.datatableId, new Set(Array.isArray(t?.publicColumns) ? t.publicColumns : [])]));
    const after = audience.applyColumnChoice(currentTables, body.publicColumns);
    for (const t of after) {
        const had = before.get(t.datatableId) || new Set();
        if ((t.publicColumns || []).some((c) => !had.has(c))) return true;
    }

    if (body.expiresAt !== undefined && expiryExtends(existing.expiresAt, body.expiresAt)) return true;

    const fromMode = existing.accessMode || 'unlisted';
    const toMode = body.accessMode || fromMode;
    if ((ACCESS_RANK[toMode] ?? 0) < (ACCESS_RANK[fromMode] ?? 0)) return true;
    if (toMode === 'email' && fromMode === 'email' && body.allowedEmails !== undefined) {
        const had = new Set(audience.normalizeEmails(existing.allowedEmails));
        if (audience.normalizeEmails(body.allowedEmails).some((e) => !had.has(e))) return true;
    }
    return false;
}

module.exports = gate;
