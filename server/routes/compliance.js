/**
 * Compliance API — AI Act & GDPR monitoring endpoints.
 *
 * All admin routes require the `admin_compliance` permission (org admins have
 * this by default; DPOs can be granted it without full admin rights).
 */

const express = require('express');
const router = express.Router();

// Ensure checks are loaded (auto-register on require)
require('../compliance/checks');

// Route logic lives in focused sub-modules under routes/compliance/, mounted
// here in the exact order the routes were registered before the split. Order
// is semantics: '/iso/docs/published/…' must stay ahead of '/iso/docs/:slug',
// and '/dpia/:agentId/pdf' ahead of '/dpia/:agentId'.
// Ahead of the rest: the paths are literal ('/access-audit', and two below
// it), and a sub-router further down that matches a bare '/:param' at the root
// would otherwise swallow them.
// Redesign (2026-09-14): the aggregate and framework routers are literal
// paths, so they go ahead of the sub-routers that match a bare '/:param'.
router.use('/', require('./compliance/counts'));
router.use('/', require('./compliance/attention'));
router.use('/', require('./compliance/deadlines'));
router.use('/', require('./compliance/frameworks'));
router.use('/', require('./compliance/calendar'));
router.use('/', require('./compliance/aiAct'));
router.use('/', require('./compliance/customFrameworks'));
router.use('/', require('./compliance/portability'));
router.use('/', require('./compliance/machinery'));
router.use('/', require('./compliance/sbom'));
router.use('/', require('./compliance/accessAudit'));
router.use('/', require('./compliance/overview'));
router.use('/', require('./compliance/checks'));
router.use('/', require('./compliance/settings'));
router.use('/', require('./compliance/chatMonitoring'));
router.use('/', require('./compliance/orgUsers'));
router.use('/', require('./compliance/isoSoa'));
router.use('/', require('./compliance/isoConnectors'));
router.use('/', require('./compliance/isoStatements'));
router.use('/', require('./compliance/isoDocs'));
router.use('/', require('./compliance/isoProcess'));
router.use('/', require('./compliance/isoAuditPack'));
router.use('/', require('./compliance/evidence'));
router.use('/', require('./compliance/ropa'));
router.use('/', require('./compliance/dpia'));
router.use('/', require('./compliance/incidents'));
router.use('/', require('./compliance/registry'));

module.exports = router;
