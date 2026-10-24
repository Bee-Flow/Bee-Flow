// @typecheck
/**
 * Route Helpers — shared utilities for Express route handlers
 * 
 * Extracted from duplicate definitions in routes/agents.js, routes/knowledge.js,
 * and routes/groupChats.js.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');
const { fallback } = require('./bestEffort');

/**
 * Lightweight session-only auth gate. Unlike the canonical `requireAuth`
 * (auth/permissions.js) it does NOT do the cached deleted-user DB round-trip —
 * use it ONLY on hot, high-frequency endpoints (e.g. SSE streams) where the
 * per-request DB check is undesirable and the surrounding flow already
 * re-resolves the user. Prefer canonical `requireAuth` everywhere else.
 * Same 401 body as the canonical gate so the client contract is identical.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireSession(req, res, next) {
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Get effective user ID from request session.
 * If authenticated, returns session user ID.
 * Otherwise, issues a random opaque guest token via a long-lived cookie and
 * returns that — prevents collisions between visitors behind the same NAT/UA.
 * Why a cookie token, not hash(IP+UA): on a shared corporate proxy, every
 * employee on the same browser version hashes to the same id, exposing each
 * other's guest conversations to GET/DELETE /:id/history.
 * @param {import('express').Request} req
 * @returns {string} User ID (never null)
 */
function getEffectiveUserId(req) {
    if (req.session?.user?.id) {
        return req.session.user.id;
    }
    if (req.session) {
        if (!req.session.guestId) {
            req.session.guestId = 'guest_' + crypto.randomBytes(12).toString('hex');
        }
        return req.session.guestId;
    }
    // Sessionless fallback (rare in this codebase): still random per request
    // rather than predictable. Caller will not get continuity across requests
    // in this branch, which is acceptable for read-only flows.
    return 'guest_' + crypto.randomBytes(12).toString('hex');
}

/**
 * Get user authentication credentials for component execution.
 * Extracts OAuth tokens, Nextcloud app passwords, and encryption keys.
 * @param {import('express').Request} req
 * @returns {Promise<object>} { accessToken, nextcloudUrl, appPasswordUsername, appPassword, encryptionKey }
 */
async function getUserAuth(req) {
    const { resolveUserOrgIds } = require('../auth/permissions');

    // Resolve the user's org for EU mode and other org-scoped features.
    //
    // ── THE MISSING `await` (A2 contradiction) ─────────────────────
    // This stood here without `await`, so `orgIds` was a Promise: `.size` is then `undefined`,
    // `undefined > 0` is false, and `userOrgId` was ALWAYS null. That null travels as
    // `messageMetadata.userOrgId` to core/agentRuntime/modelResolver.js and chatStream.js, where it is
    // the key under which the EU override and the org's own tier map are looked up — a personal agent
    // of a member of an EU org was thus always resolved against the global, non-EU tier map.
    //
    // `strict`, because "not readable" must not end here as "no org". A helper cannot return a 503, so
    // the fallback is the org from the session (the same source that routes/ai/automationBuilder/
    // layerAgent.js uses) and otherwise an explicit `userOrgUnknown` — a reader who wants to narrow on
    // that can do so, and nobody has to read "null" as two things.
    let orgIds = null;
    let orgUnknown = false;
    try {
        orgIds = await resolveUserOrgIds(req, { strict: true });
    } catch (e) {
        orgUnknown = true;
        log.warn('[routeHelpers] could not resolve the workspace:', e.message);
    }
    let userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    if (userOrgId === null && orgUnknown) userOrgId = req.session?.user?.organizationId || null;
    const userOrgUnknown = orgUnknown && !userOrgId;

    const userAuth = {
        accessToken: req.session?.accessToken || null,
        nextcloudUrl: null,
        appPasswordUsername: null,
        appPassword: null,
        encryptionKey: req.session?.encryptionKey || null,
        userId: req.session?.user?.id || null,
        session: req.session || null,
        userOrgId,
        // `true` = the workspace was NOT readable. `userOrgId: null` on its own means "no org" (or super
        // admin), and those two must not land on one value.
        userOrgUnknown
    };

    const configStore = require('../stores/configStore');
    try {
        const oauth = (await configStore.getConfig('oauth')) || {};
        userAuth.nextcloudUrl = oauth.nextcloudUrl || null;
    } catch (e) { fallback('utils/routeHelpers:getUserAuth', e); /* oauth config unavailable, the Nextcloud URL is omitted */ }

    // Check if app password was passed via session token (for embedded iframe)
    if (req.session?.appPassword) {
        userAuth.appPasswordUsername = req.session.appPassword.username;
        userAuth.appPassword = req.session.appPassword.password;
        // A per-user Nextcloud URL stored alongside the credential wins over org config.
        if (req.session.appPassword.url) userAuth.nextcloudUrl = req.session.appPassword.url;
    } else {
        // Otherwise look up from userStore
        const userId = req.session?.user?.id;
        if (userId) {
            const userStore = require('../stores/userStore');
            const appPasswordData = await userStore.getAppPassword(userId);
            if (appPasswordData) {
                userAuth.appPasswordUsername = appPasswordData.username;
                userAuth.appPassword = appPasswordData.password;
                if (appPasswordData.url) userAuth.nextcloudUrl = appPasswordData.url;
            }
        }
    }

    return userAuth;
}

module.exports = {
    requireSession,
    getEffectiveUserId,
    getUserAuth
};
