/**
 * Everything the MCP library reaches outside itself, resolved lazily.
 *
 * Stores touch the database at require time, the client loads the MCP SDK,
 * so nothing here is required until it is used. Tests replace an entry on
 * this object (and put it back) instead of reaching into the module system;
 * see core/privacy/toolPiiGate.js for the same seam.
 */

const deps = {
    store: () => require('../../../stores/orgCustomIntegrationStore'),
    connStore: () => require('../../../stores/integrationConnectionStore'),
    userStore: () => require('../../../stores/userStore'),
    mcpStore: () => require('../../../stores/mcpStore'),
    configStore: () => require('../../../stores/configStore'),
    entitlements: () => require('../../entitlements/entitlements'),
    mcpClient: () => require('../customMcpClient'),
    isBuilderEnabled: () => require('../featureFlag').isCustomIntegrationsEnabled(),
};

module.exports = deps;
