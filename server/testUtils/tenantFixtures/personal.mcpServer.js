// @typecheck strict
/**
 * Tenant-isolation fixtures: an MCP access token of a person of org B (the mcp_server module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';


/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // An MCP access token of user B (routes/mcpTokens.js): switched and revoked under the caller's user id only.
        kind: 'mcpToken',
        mount: '/api/mcp-tokens',
        router: () => require('../../routes/mcpTokens'),
        create: async ({ orgId, userId, index }) => {
            const { record } = await require('../../auth/mcpAccess/tokenStore').createToken({
                userId, orgId, name: `Token ${index}`, scopes: { automations: { level: 'read' } }, ipAllowlist: null, expiresAt: null,
            });
            return /** @type {{ id: string }} */ (record).id;
        },
        routes: ['PATCH /api/mcp-tokens/:id', 'DELETE /api/mcp-tokens/:id'],
        bodies: { 'PATCH /api/mcp-tokens/:id': { enabled: false } },
    },
];

module.exports = { FIXTURES };
