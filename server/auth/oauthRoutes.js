// @typecheck
/**
 * OAuth Routes — Multi-Provider OAuth 2.0
 * 
 * Handles: /login (legacy NC), /callback (legacy NC),
 * /login/:provider, /callback/:provider,
 * /oauth-config, /providers, /providers/:provider, /providers/:provider/test
 */

const express = require('express');
const router = express.Router();

const credentialRoutes = require('./oauth/credentialRoutes');

// Split by flow into auth/oauth/ modules. The mounting order below IS the
// original route registration order — route and middleware order are semantics.
router.use(require('./oauth/loginPickupRoutes'));
router.use(require('./oauth/nextcloudLegacyRoutes'));
router.use(require('./oauth/providerLoginRoutes'));
router.use(require('./oauth/providerCallbackRoutes'));
router.use(require('./oauth/ssoConfigRoutes'));
router.use(require('./oauth/microsoftBindingRoutes'));
router.use(credentialRoutes);

module.exports = router;
// Shared with the integration connectors' disconnect flows, which require it
// from this path (routes/integrations/{googleWorkspace,microsoft365,withings,
// connections}.js).
module.exports.revokeProviderCredential = credentialRoutes.revokeProviderCredential;
