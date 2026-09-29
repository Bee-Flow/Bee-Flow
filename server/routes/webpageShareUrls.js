/**
 * Share-URL exposure rules for GET /api/webpages/:id/public-shares.
 *
 * Extracted from routes/webpages.js so it can be tested without loading the
 * whole webpages router (which opens the pg pool and starts the pricing/usage
 * interval timers on require). Pure functions, no I/O.
 *
 * BFSF-186 — "cannot retrieve or copy the URL of a webpage created by another
 * user". Two rules together make a colleague's link copyable:
 *
 *   1. `listingCreatorScope` — a non-owner reader must list EVERY share on the
 *      page, not their own. Scoping the query to the caller returns an empty
 *      list for exactly the case the bug is about, and the UI then reports
 *      "the owner hasn't created any external links".
 *   2. `attachShareUrls` — rebuild the URL wherever the raw token is still
 *      recoverable (encrypted at rest, BFSF-188), and only there. Revoked,
 *      expired and legacy (no ciphertext) shares degrade to `url: null`
 *      rather than handing out a link that the viewer route would reject
 *      anyway.
 *
 * `stripOwnerOnlyFields` keeps the two apart: the URL is shareable, the
 * owner's chosen recipient allow-list is not.
 */

/**
 * What to pass as `createdBy` to publicShareStore.listSharesForWebpage.
 * null = every share on the page (read-visibility for non-owners).
 */
function listingCreatorScope(isOwner, userId) {
    return isOwner ? userId : null;
}

/** Non-owners must not see whom the owner sent the link to. */
function stripOwnerOnlyFields(shares, isOwner) {
    if (isOwner) return shares;
    return shares.map(({ allowedEmails, ...rest }) => rest);
}

/** A share is linkable only while it is neither revoked nor past its expiry. */
function isShareLinkable(share, now = Date.now()) {
    if (!share || share.revokedAt) return false;
    if (!share.expiresAt) return true;
    const expiry = new Date(share.expiresAt).getTime();
    // An unparseable expiry is treated as dead — fail closed, never hand out
    // a link we cannot reason about.
    if (Number.isNaN(expiry)) return false;
    return expiry >= now;
}

/**
 * Add `url` to each share. `tokens` is the { [shareId]: rawToken } map from
 * publicShareStore.getRetrievableTokens; `buildUrl(rawToken)` renders it.
 */
function attachShareUrls(shares, tokens, buildUrl, now = Date.now()) {
    const map = tokens || {};
    return (shares || []).map(s => ({
        ...s,
        url: (map[s.id] && isShareLinkable(s, now)) ? buildUrl(map[s.id]) : null,
    }));
}

module.exports = {
    listingCreatorScope,
    stripOwnerOnlyFields,
    isShareLinkable,
    attachShareUrls,
};
