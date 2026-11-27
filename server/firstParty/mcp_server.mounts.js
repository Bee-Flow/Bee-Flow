// @typecheck strict
'use strict';
/**
 * The mounts of module "mcp_server" (Bee Flow as an MCP server): its rows of the route table
 * that the core mounts, as data (modules/firstParty/contract.js MountRow), with the
 * same gates. Order: the core's (modules/firstParty/order.json "mounts"): the three builder
 * endpoints come before /mcp; routers are required at mount time.
 *
 * The builder endpoints are switched by the module that owns the toolset (apps, automation,
 * cms), which this module only `uses`: when that module is absent its switch counts as off,
 * so an absent apps never fails this module.
 */


/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/**
 * Is the builder toolset switched on? False when the module that owns it is absent.
 * @param {'appStudio/mcpBuilder' | 'automation/mcpBuilder' | 'cms/mcp/index'} name the toolset's builder, by name
 */
const switchedOn = (name) => require('../core/featureModules').optionalFeatureModule(name)?.isEnabled() === true;

/** @type {MountRow[]} */
const mounts = [
    // App Studio over MCP — the builder toolset for an external coding agent, so a
    // customer app can be authored against a live instance instead of shipped as a
    // template module in a new image. FULLY GATED: without STUDIO_MCP_ENABLED=1 the
    // path does not exist and the module is never loaded. Mounted BEFORE /mcp so
    // the more specific path wins regardless of Express match order.
    { key: 'mcp_server:/mcp/studio', slot: 'main', path: '/mcp/studio', when: () => switchedOn('appStudio/mcpBuilder'), handlers: () => [require('../routes/mcpStudio')], onMount: (log) => log.info('[Server] App Studio MCP endpoint mounted at /mcp/studio (STUDIO_MCP_ENABLED=1).') },
    // Automations over MCP — the same story for the automation builder, so an automation
    // can be authored against a live instance instead of driven turn by turn
    // through the chat builder. Same gating shape as the Studio endpoint above:
    // without AUTOMATION_MCP_ENABLED=1 the path does not exist and the module is
    // never loaded. Also mounted BEFORE /mcp so the more specific path wins.
    { key: 'mcp_server:/mcp/automations', slot: 'main', path: '/mcp/automations', when: () => switchedOn('automation/mcpBuilder'), handlers: () => [require('../routes/mcpAutomations')], onMount: (log) => log.info('[Server] Automations MCP endpoint mounted at /mcp/automations (AUTOMATION_MCP_ENABLED=1).') },
    // The product website (CMS) over MCP — edit pages, header/footer, translations,
    // upload local media, screenshot and (with the cms.publish scope) publish from an
    // external coding agent. Same gating shape: without CMS_MCP_ENABLED=1 the path
    // does not exist and the module is never loaded. Also mounted BEFORE /mcp.
    { key: 'mcp_server:/mcp/cms', slot: 'main', path: '/mcp/cms', when: () => switchedOn('cms/mcp/index'), handlers: () => [require('../routes/mcpCms')], onMount: (log) => log.info('[Server] CMS MCP endpoint mounted at /mcp/cms (CMS_MCP_ENABLED=1).') },
    // Bee Flow AS an MCP server. Deliberately NOT under /api: MCP clients are
    // configured with a bare URL, and the endpoint authenticates with its own
    // Bearer token rather than a session cookie (see routes/mcpServer.js).
    { key: 'mcp_server:/mcp', slot: 'main', path: '/mcp', handlers: () => [require('../routes/mcpServer')] },
    // Self-service token management for /mcp — session-authenticated.
    { key: 'mcp_server:/api/mcp-server', slot: 'main', path: '/api/mcp-server', handlers: (g) => [g.requireAuthedUser, require('../routes/mcpServerTokens')] },
    // Named MCP access tokens (scopes, expiry, IP allow-list), per user, session-authenticated.
    { key: 'mcp_server:/api/mcp-tokens', slot: 'main', path: '/api/mcp-tokens', handlers: (g) => [g.requireAuthedUser, require('../routes/mcpTokens')] },
];

module.exports = { mounts };
