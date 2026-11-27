// @typecheck strict
'use strict';
/**
 * The mounts of module "webpages": its rows of the route table of server/index.js and of the
 * /ai router (routes/ai.js), as data (modules/firstParty/contract.js MountRow), with the same
 * gates. Order: the core's (modules/firstParty/order.json "mounts" and "aiMounts"); routers are
 * required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */
/** @typedef {import('../modules/firstParty/contract').Gates} Gates */

/**
 * Webpage chat — gated through the same `webpages` capability as the
 * /api/webpages mount, so the AI build path and the list/CRUD API can never
 * disagree (the split that made the page render while its API 403'd). Path-
 * scoped so the gate only fires on /chat/webpage/* and not on the rest of /ai.
 * @param {Gates} g
 */
function webpageChatGateFor(g) {
    const webpageCapGate = g.requireCapability('webpages');
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    const webpageChatGate = (req, res, next) => {
        if (!req.path.toLowerCase().startsWith('/chat/webpage')) return next();
        return webpageCapGate(req, res, next);
    };
    return webpageChatGate;
}

/** @type {MountRow[]} */
const mounts = [
    // Webpages — compound beta (license 'webpages' AND the webpages beta). The
    // unified gate enforces both via the resolver's effective.beta set and honours
    // per-group grants.
    { key: 'webpages:/api/webpages', slot: 'main', path: '/api/webpages', handlers: (g) => [g.requireModule('webpages'), g.requireCapability('webpages'), g.requireTraining('webpages'), require('../routes/webpages')] },
    { key: 'webpages:/api/webpages#export', slot: 'main', path: '/api/webpages', handlers: (g) => [g.requireModule('webpages'), g.requireCapability('webpages'), require('../routes/webpageExport')] },
    // Cross-origin endpoints called from the sandboxed preview iframe — guarded
    // by HMAC bearer tokens (issued by the session-authenticated /api/webpages routes),
    // not by the session itself, since the iframe has no cookies.
    { key: 'webpages:/api/webpages-preview', slot: 'main', path: '/api/webpages-preview', handlers: (g) => [g.requireModule('webpages'), require('../routes/webpagesPreview')] },
    // Anonymous AI bridge for externally-shared webpages — guarded by a
    // share-scoped HMAC bridge token (minted at content-serve time only when the
    // author opted the share into public AI). Sibling of /share so the strict
    // /share CSP stays untouched. Chat/stream only; acts-as-author with rate
    // limits + spend cap.
    { key: 'webpages:/api/public-share', slot: 'main', path: '/api/public-share', handlers: (g) => [g.requireModule('webpages'), require('../routes/publicShareBridge')] },
    // Public webpage viewer — unauthenticated `/share/:token` route for external
    // recipients of a published webpage. Has its own rate limiter, strict CSP,
    // HMAC-signed magic links and unlock cookies. License/beta gates do NOT
    // apply: once a publisher (whose org is gated) creates a share, recipients
    // are anonymous third parties.
    { key: 'webpages:/share', slot: 'main', path: '/share', handlers: (g) => [g.requireModule('webpages'), require('../routes/publicViewer')] },
    // The same viewer file, second address: /w/<slug> — the address of the PAGE instead of that of the
    // share (W3 step 4). The page points, via `public_share_id`, at one canonical share; that is served
    // here with exactly the same gate, rate limits, CSP and sandbox. One router on two mounts, on purpose:
    // a second viewer would be a second access check.
    { key: 'webpages:/w', slot: 'main', path: '/w', handlers: (g) => [g.requireModule('webpages'), require('../routes/publicViewer')] },
];

/** @type {MountRow[]} */
const aiMounts = [
    { key: 'webpages:webpageChatGate', path: null, handlers: (g) => [webpageChatGateFor(g)] },
    { key: 'webpages:webpageChat', path: '/', handlers: () => [require('../routes/ai/webpageChat')] },
];

module.exports = { mounts, aiMounts };
