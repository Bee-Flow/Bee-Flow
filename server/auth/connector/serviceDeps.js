// @typecheck
/**
 * The one place the connector bootstrap reaches up into services/: the
 * org-health recorder and the plan entitlements. connectorBootstrap.js and the
 * connector/ modules it is split into take both from here, so the split adds
 * no auth -> services edge (server/layering.test.js counts every require).
 */

const orgHealth = require('../../services/orgHealth');
const planEntitlements = require('../../services/planEntitlements');

module.exports = { orgHealth, planEntitlements };
