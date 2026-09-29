/**
 * Resolve the externally-reachable base URL of this server.
 *
 * Two callers, two needs:
 *   - MS Graph subscription provisioning (`triggerBus.provisionSubscription`)
 *     requires a real, publicly-resolvable HTTPS origin and must SKIP when
 *     there isn't one — hence `getPublicBaseUrl()` returning null.
 *   - Showing a user their inbound webhook URL (BFSF-320) only needs an origin
 *     that works from wherever they are. On self-host that is simply whatever
 *     host they reached us on, so `resolvePublicBaseUrl(req)` falls back to the
 *     request origin rather than refusing to produce a URL. Requiring
 *     PUBLIC_BASE_URL there would leave every self-host install with a webhook
 *     trigger that never shows an endpoint.
 */

/**
 * The configured public origin, or null when unset. Never guesses.
 * @returns {string|null}
 */
function getPublicBaseUrl() {
    return process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_URL || null;
}

/**
 * Best-effort public origin for user-facing URLs. Prefers the configured
 * value, else reconstructs the origin from the request (honouring the
 * X-Forwarded-* headers Express populates when `trust proxy` is on, which is
 * what makes this correct behind the nginx ingress).
 *
 * @param {import('express').Request} [req]
 * @returns {string} origin with no trailing slash, e.g. "https://app.beeflow.nl"
 */
function resolvePublicBaseUrl(req) {
    const configured = getPublicBaseUrl();
    if (configured) return String(configured).replace(/\/+$/, '');
    if (req) {
        const host = req.get?.('host');
        if (host) return `${req.protocol || 'https'}://${host}`;
    }
    return '';
}

/**
 * Absolute URL of an inbound automation webhook slug.
 * Mirrors the route mounted at `POST /api/automation/webhook/:slug`
 * (routes/automation/events.js).
 *
 * @param {string} slug
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function webhookUrlForSlug(slug, req) {
    return `${resolvePublicBaseUrl(req)}/api/automation/webhook/${slug}`;
}

/**
 * Absolute URL of a hosted form page. This is the link an author pastes into a
 * website or an email, so it is deliberately short and human-typeable — the SPA
 * serves `/f/:token` (see agent-hub App.jsx; `f` is reserved in both
 * cmsPublicRouting.js and cmsDefaults.js so the CMS catch-all can't claim it).
 *
 * @param {string} token
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function formUrlForToken(token, req) {
    return `${resolvePublicBaseUrl(req)}/f/${token}`;
}

/**
 * Absolute URL of a Studio app's public page — the link an owner sends to the
 * people who fill in the app's intake screens. Same shape and same reasoning as
 * formUrlForToken: short and human-typeable, served by the SPA at `/p/:token`
 * (see agent-hub App.jsx; `p` is reserved in publicPath.js, cmsPublicRouting.js
 * and cmsDefaults.js so the CMS catch-all can't claim it). NOT `/a/` — that
 * segment already routes to agents inside the authenticated app.
 *
 * @param {string} token
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function publicAppUrlForToken(token, req) {
    return `${resolvePublicBaseUrl(req)}/p/${token}`;
}

/**
 * Absolute URL of one approval, for a card delivered OUTSIDE the app — a
 * Nextcloud Talk message, a Nextcloud notification, anywhere the reader is not
 * already inside the SPA and a relative path would resolve against the wrong
 * host.
 *
 * Deliberately the ORDINARY, session-gated app path (`/app/studio/approvals/:id`),
 * not a token URL. `automation_runs.approval_token` exists but is documented in
 * its own migration as "NOT an HMAC and not yet validated anywhere", and
 * app-sourced approvals have no run and therefore no token at all — so it
 * cannot be the basis for a public link. For a Nextcloud user who is already an
 * SSO'd Bee Flow user this is one click and zero new attack surface. A tokenised
 * public route (modelled on routes/automation/formPublic.js) is a follow-up for
 * approvers who have no Bee Flow account.
 *
 * Returns a path when no public origin is configured — still correct inside the
 * app, merely not clickable from Nextcloud, which is the honest degradation.
 *
 * @param {string} approvalId
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function approvalUrlForId(approvalId, req) {
    const { approvalPath } = require('../utils/appPaths');
    return `${resolvePublicBaseUrl(req)}${approvalPath(approvalId)}`;
}

module.exports = { getPublicBaseUrl, resolvePublicBaseUrl, webhookUrlForSlug, formUrlForToken, publicAppUrlForToken, approvalUrlForId };
