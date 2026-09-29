// @typecheck
/**
 * Admin Routes — User, Organization, Group, Role CRUD + App Passwords
 * 
 * All routes require authentication. Most require admin access.
 */

const express = require('express');
const router = express.Router();

// Split by resource into auth/admin/ modules. The mounting order below IS the
// original route registration order — route and middleware order are semantics.
router.use(require('./admin/userRoutes'));
router.use(require('./admin/orgRoutes'));
router.use(require('./admin/groupRoleRoutes'));
router.use(require('./admin/appPasswordRoutes'));
router.use(require('./admin/featureAccessRoutes'));
router.use(require('./admin/leaveOrgRoutes'));
router.use(require('./admin/platformConfigRoutes'));
router.use(require('./admin/invitationRoutes'));

const { isOrgAdminForOrg, requireOrgAdmin } = require('./admin/orgAdminGuards');

module.exports = router;
// Shared org-admin helpers — reused by org-scoped routers mounted outside
// this file (e.g. routes/orgIntegrations/builder.js).
module.exports.isOrgAdminForOrg = isOrgAdminForOrg;
module.exports.requireOrgAdmin = requireOrgAdmin;
