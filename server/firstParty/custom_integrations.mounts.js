// @typecheck strict
'use strict';
/**
 * The mounts of module "custom_integrations": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order:
 * the core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // AI Integration Builder — org-admin API for org-scoped custom integrations.
    // Double gate at mount: the 'ai_integration_builder' beta capability AND the
    // dark-ship kill switch (feature_custom_integrations_enabled, fail-closed 404).
    { key: 'custom_integrations:/api/organizations/:orgId/custom-integrations', slot: 'main', path: '/api/organizations/:orgId/custom-integrations', handlers: (g) => [g.requireCapability('ai_integration_builder'), require('../core/customIntegrations/featureFlag').customIntegrationsFeatureGate, require('../routes/orgIntegrations/builder')] },
    // MCP library — organisation admins install remote MCP servers for their own
    // organisation; members add their own keys; the server admin sets the policy.
    // Gates live in the router (requirePrimaryOrgAdmin + mcp_marketplace licence,
    // requireSuperAdmin for the policy). Remote-only: nothing here spawns a process.
    { key: 'custom_integrations:/api/mcp-library', slot: 'main', path: '/api/mcp-library', handlers: () => [require('../routes/mcpLibrary')] },
];

module.exports = { mounts };
