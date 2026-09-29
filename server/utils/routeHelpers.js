// @typecheck
/**
 * Route Helpers — shared utilities for Express route handlers
 * 
 * Extracted from duplicate definitions in routes/agents.js, routes/knowledge.js,
 * and routes/groupChats.js.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');

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
    const { resolveUserOrgIds } = require('../auth');

    // Resolve user's org for EU mode and other org-scoped features.
    //
    // ── DE ONTBREKENDE `await` (A2-tegenspraak) ─────────────────────
    // Dit stond hier zonder `await`, dus `orgIds` was een Promise: `.size` is
    // dan `undefined`, `undefined > 0` is false, en `userOrgId` was ALTIJD
    // null. Die null reist mee als `messageMetadata.userOrgId` naar
    // core/agentRuntime/modelResolver.js en chatStream.js, waar hij de sleutel
    // is waarop de EU-override en de org-eigen tiermap worden opgezocht — een
    // persoonlijke agent van een lid van een EU-org werd zo altijd tegen de
    // globale, niet-EU tiermap opgelost.
    //
    // `strict`, want "niet te lezen" mag hier niet als "geen org" eindigen. Er
    // valt in een helper geen 503 te geven, dus de val is de org uit de sessie
    // (dezelfde bron die routes/ai/automationBuilder/layerAgent.js gebruikt) en
    // anders een expliciete `userOrgUnknown` — een lezer die daarop wil
    // versmallen kan dat, en niemand hoeft "null" voor twee dingen te lezen.
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
        // `true` = de workspace was NIET te lezen. `userOrgId: null` alleen
        // betekent "geen org" (of super-admin), en die twee horen niet op één
        // waarde te landen.
        userOrgUnknown
    };

    const configStore = require('../stores/configStore');
    try {
        const oauth = (await configStore.getConfig('oauth')) || {};
        userAuth.nextcloudUrl = oauth.nextcloudUrl || null;
    } catch (e) { }

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
