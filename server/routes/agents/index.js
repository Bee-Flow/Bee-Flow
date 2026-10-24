const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../utils/routeHelpers');

// Mount sub-routers in the exact order they appeared in the original file
// Meta & All Conversations must intercept before /:id routes
router.use('/', require('./meta'));
router.use('/', require('./conversations_meta'));
router.use('/', require('./published'));
// POST /:id/publish-version — content publish (concept → published_*);
// PATCH /:id/publish in ./published stays the audience toggle.
router.use('/', require('./publishVersion'));
router.use('/', require('./system'));
// GET /tool-catalog — the apps + actions the agent tool picker grants from.
// Mounted before ./crud so `/:id` never shadows it, and deliberately NOT in
// ./meta: that file is exempted app-wide as "metadata, no user data" and this
// answer is per-user (it says which apps THIS caller may use), so it carries
// its own requireAuth. See the file header for why it exists next to
// /api/automation/catalog.
router.use('/', require('./toolCatalog'));
// Favorites must come before /:id routes so GET /favorites is not captured by GET /:id
router.use('/', require('./favorites'));
// Wizard endpoints (/wizard/*) must come before /:id routes
router.use('/', require('./wizard'));

// POST /:id/persona/parse — "back to fields". Mounted before ./crud so the
// persona sub-path is never shadowed by a future /:id/* handler there.
router.use('/', require('./persona'));

// GET /:id/usage — the "Used by" tab. Same reason for the early mount; it
// also shares gatherUsage() with the delete guard in ./crud.
router.use('/', require('./usage'));

// /:id/tests and /:id/tests/run — the Testen tab. Mounted before ./crud for
// the same reason as ./persona and ./usage: the sub-path must never be
// shadowed by a future /:id/* handler there.
router.use('/', require('./tests'));

// GET /:id/tool-lending — for which apps this agent may borrow the connection of
// its OWNER. Belongs with ./toolCatalog (together they feed the Tools card) but stands apart because it is a PER-AGENT answer with the edit right as
// its gate, where the catalogue is per user. Same early mount as ./usage.
router.use('/', require('./toolLending'));

// Specific /:id routes
router.use('/', require('./crud'));
router.use('/', require('./chat'));
router.use('/', require('./conversations'));

module.exports = { router, getEffectiveUserId };
