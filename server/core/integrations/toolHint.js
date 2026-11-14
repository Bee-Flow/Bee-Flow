// @typecheck
'use strict';

/**
 * buildToolHint: the human-readable integration line appended to the system
 * prompt for the tools a turn received. Split out of integrationTools.js;
 * moved verbatim.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const { familyLines } = require('./toolHintFamilies');

/**
 * MCP (Model Context Protocol) tools, dynamically discovered from connected
 * external servers: one line per server (mcp_{serverId}_{toolName}).
 * @param {Array<{ function?: { name?: string, description?: string } }>} tools
 */
function mcpLines(tools) {
    const mcpTools = tools.filter(t => t.function?.name?.startsWith('mcp_'));
    log.info(`[MCP-DEBUG] buildToolHint: ${tools.length} total tools received, ${mcpTools.length} are MCP tools`);
    if (mcpTools.length === 0) return [];
    /** @type {Record<string, string[]>} */
    const serverMap = {};
    for (const t of mcpTools) {
        const fn = /** @type {{ name: string, description?: string }} */ (t.function);
        const parts = fn.name.split('_');
        // mcp_{serverId}_{rest...} — server ID is the second segment
        const serverId = parts[1] || 'unknown';
        if (!serverMap[serverId]) serverMap[serverId] = [];
        serverMap[serverId].push(fn.description || fn.name);
    }
    log.info(`[MCP-DEBUG] buildToolHint: MCP servers found: ${Object.keys(serverMap).join(', ')}`);
    return Object.entries(serverMap).map(([serverId, toolDescs]) => {
        const label = serverId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return `${label} via MCP (${toolDescs.length} tools: ${toolDescs.slice(0, 5).join(', ')}${toolDescs.length > 5 ? `, ... and ${toolDescs.length - 5} more` : ''})`;
    });
}

/**
 * Custom org integrations (AI Integration Builder) — cint_<slug>_<tool>.
 * Cheap by construction: skipped entirely when no cint_ tools made it into
 * the list, one getBySlug lookup per distinct integration otherwise.
 * Fail-soft: a store hiccup only costs the hint line, never the tools.
 * @param {Array<{ function?: { name?: string } }>} tools
 * @param {{ customIntegrationRunner: () => { parsePrefixedName: (n: string) => { slug: string } | null },
 *   orgCustomIntegrationStore: () => { getBySlug: (slug: string) => Promise<{ name?: string | null } | null | undefined> } }} lazy
 * @returns {Promise<string[]>}
 */
async function customIntegrationLines(tools, lazy) {
    const cintTools = tools.filter(t => t.function?.name?.startsWith('cint_'));
    if (cintTools.length === 0) return [];
    /** @type {string[]} */
    const lines = [];
    try {
        const { parsePrefixedName } = lazy.customIntegrationRunner();
        const orgCustomIntegrationStore = lazy.orgCustomIntegrationStore();
        /** @type {Map<string, string[]>} */
        const bySlug = new Map();
        for (const t of cintTools) {
            const name = /** @type {string} */ (t.function && t.function.name);
            const parsed = parsePrefixedName(name);
            if (!parsed) continue;
            if (!bySlug.has(parsed.slug)) bySlug.set(parsed.slug, []);
            /** @type {string[]} */ (bySlug.get(parsed.slug)).push(name);
        }
        for (const [slug, toolNames] of bySlug) {
            const row = await orgCustomIntegrationStore.getBySlug(slug);
            if (!row || !row.name) continue;
            lines.push(`${row.name} (custom org integration: ${toolNames.join(', ')})`);
        }
    } catch (err) { fallback('core/integrations/toolHint:buildToolHint', err); /* fail soft — hint only, the tools themselves still work */ }
    return lines;
}

function createBuildToolHint({ lazy }) {
    /**
     * Build human-readable integration hints for the system prompt.
     * @param {Array} tools - Tool definitions array
     * @param {string | null} [_userId]
     * @returns {Promise<string>} Integration hint string to append to system prompt
     */
    async function buildToolHint(tools, _userId = null) {

        if (tools.length === 0) return '';

        const integrations = [...familyLines(tools), ...mcpLines(tools), ...await customIntegrationLines(tools, lazy)];

        let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
        if (integrations.length > 0) {
            hint += ` Your available integrations: ${integrations.join(', ')}.`;
        }
        log.info(`[MCP-DEBUG] buildToolHint final integrations: [${integrations.join(', ')}]`);

        return hint;
    }

    return buildToolHint;
}

module.exports = { createBuildToolHint };
