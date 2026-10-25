// @typecheck noImplicitAny
/**
 * Auth Module — the /auth router.
 *
 * Composes the auth sub-routers. Loaded ONLY by the composition root
 * (server/index.js mounts it at /auth); everything else that needs an auth
 * gate or helper requires auth/permissions.js or auth/audience.js (or the
 * auth/index.js facade), none of which loads a route file. That keeps a
 * middleware import from dragging the whole auth HTTP surface (and the cycles
 * through it) into a store, a feature or core/.
 *
 * auth/router.test.js guards both halves: requiring auth/index.js loads no
 * route file, and only server/index.js requires this one. The mount order
 * below is the order requests are matched in: keep it.
 */

const express = require('express');
const router = express.Router();

// Mount sub-routers
router.use('/', require('./loginRoutes'));
router.use('/', require('./oauthRoutes'));
router.use('/', require('./adminRoutes'));
router.use('/', require('./connectorAdminRoutes'));
router.use('/', require('./connectorBootstrap'));
router.use('/', require('./ncBindingRoutes'));
router.use('/opaque', require('./opaqueRoutes'));

module.exports = router;
