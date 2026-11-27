// @typecheck strict
/**
 * AI Routes — Slim Router Mount
 * 
 * All route logic has been split into focused sub-modules in routes/ai/.
 * This file just mounts them under the /api/ai prefix.
 */

const express = require('express');
const router = express.Router();

// Sub-route modules
const configRoutes = require('./ai/config');
const providerRoutes = require('./ai/providers');
const localRuntimeRoutes = require('./ai/localRuntimes');
const directChatRoutes = require('./ai/directChat');

const voiceRoutes = require('./ai/voice');
const swarmsRoutes = require('./ai/swarms');
const { requireCapability } = require('../core/entitlements/entitlements');
const { requireModule } = require('../modules');
const firstParty = require('../modules/firstParty/loader');

/** @typedef {import('../modules/firstParty/contract').Gates} Gates */

/**
 * The gates the /ai mount rows get: the same factories as boot/gates.js, built here because
 * routes/ may not require boot/ (layering.test.js). featureGate (boot/) and requireTraining
 * (module learning) are out of reach from here and refuse loudly when an /ai row asks for one
 * (the loader then marks that module failed); no /ai row uses either.
 * @returns {Gates}
 */
function aiGates() {
    /** @param {string} name */
    const unavailable = (name) => () => { throw new TypeError(`gates.${name} is not available to the /ai mount rows (routes/ai.js)`); };
    return {
        requireModule,
        requireCapability,
        get requireLicenseFeature() { return require('../license/middleware').requireFeature; },
        get requireAuthedUser() { return require('../auth').requireAuth; },
        get requireAnyPermission() { return require('../auth/permissions').requireAnyPermission; },
        get googleSessionHydration() { return require('../auth/googleSessionHydration').googleSessionHydration; },
        get microsoftSessionHydration() { return require('../auth/microsoftSessionHydration').microsoftSessionHydration; },
        featureGate: unavailable('featureGate'),
        requireTraining: unavailable('requireTraining'),
    };
}

// Mount all sub-routes
router.use('/', configRoutes);
router.use('/', providerRoutes);
router.use('/', localRuntimeRoutes);
router.use('/', directChatRoutes);

// The sub-routers of the first-party modules (firstParty/<id>.mounts.js aiMounts),
// in the order of modules/firstParty/order.json "aiMounts": template chat, the
// notebook chat gate and router, the webpage chat gate and router, then
// '/learning/admin' BEFORE '/learning' (router.use('/learning') also matches
// '/learning/admin/*'). Here, ahead of /voice and /swarms: the '/' and path-less
// rows overlap every path, so they keep their place before those two.
firstParty.mountAi(router, aiGates());

// Voice Chat (Beta) — gated on org-level beta feature flag.
// Further gated on a configured Mistral API key by the voice router itself.
// Mounted at /voice so the beta gate only affects /ai/voice/* requests.
router.use('/voice', requireCapability('voice_chat'), voiceRoutes);

// Swarm Agents (Beta) — gated on org-level beta feature flag. The discovery
// endpoint also returns [] when the gate is disabled, so the sidebar simply
// hides the "Swarms" section for non-eligible users.
router.use('/swarms', requireCapability('swarm'), swarmsRoutes);

module.exports = router;
