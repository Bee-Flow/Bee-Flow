// @typecheck
'use strict';

/**
 * Tools that come from outside the static tool catalog: connected MCP servers
 * (`mcp:<serverId>`) and org-scoped custom integrations (`custom:<uuid>`),
 * both gated by the caller's effective integration set. Shared by
 * getIntegrationTools (running user) and agentRuntime/agentTools (agent
 * owner). Split out of integrationTools.js; moved verbatim.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

const log = require('../../telemetry/log');

function createExternalToolInjection({ lazy }) {
    /**
     * Append connected MCP-server tools to a tool list, gated by the caller's
     * effective integration set. Shared by getIntegrationTools (running user) and
     * agentRuntime/agentTools (agent owner) so the gating lives in ONE place.
     *
     *   effectiveIntegrations : Set<string> of granted integration ids, or null.
     *     null ⇒ fail-closed (no MCP tools) — the resolver was unavailable/degraded.
     *   Each MCP server `mcp:<id>` must be present in the set to expose its tools.
     *   (No tier/umbrella gate — MCP servers are plain integrations.)
     */
    async function appendMcpTools(tools, { effectiveIntegrations, isToolGranted = null }) {
        if (!effectiveIntegrations) return; // fail closed
        try {
            const mcpManager = lazy.mcpManager();
            const mcpTools = await mcpManager.getAllToolsAsOpenAI();
            for (const t of mcpTools) {
                const serverId = t._mcp?.serverId;
                if (!serverId) continue;                                  // unidentifiable ⇒ fail closed
                if (!effectiveIntegrations.has(`mcp:${serverId}`)) continue;
                if (isToolGranted && !isToolGranted(t)) continue;         // per-action grant
                if (!tools.find(x => x.function?.name === t.function?.name)) tools.push(t);
            }
        } catch (e) {
            log.warn('[IntegrationTools] MCP injection failed:', e.message);
        }
    }

    /**
     * MCP server ids this user could actually observe events from: their tools
     * survived the `mcp:<id>` capability gate into `toolNames`, AND the user has
     * supplied every credential the server requires.
     *
     * Both terms are needed. `tools_cache` is server-global and appendMcpTools does
     * no credential check, so a granted-but-uncredentialled user would otherwise be
     * offered a trigger that can never poll anything.
     *
     * Used to resolve `{ kind: 'mcp' }` availability for app_event trigger
     * providers, which cannot use the app-id path: MCP servers have no
     * TOOL_REGISTRY row and so never appear in the catalog's availableAppIds.
     *
     * Matches server ids forward onto tool names rather than parsing ids back out
     * of them — getAllToolsAsOpenAI sanitises the whole name ([^A-Za-z0-9_] → _),
     * so a hyphenated id is not recoverable from the tool name.
     *
     * Returns booleans only; no secret value ever leaves this function. Any failure
     * yields an empty set (fail closed) — it can only ever hide a provider.
     */
    async function availableMcpServerIds(toolNames, userId) {
        const out = new Set();
        if (!userId || !(toolNames instanceof Set) || toolNames.size === 0) return out;
        try {
            const mcpManager = lazy.mcpManager();
            for (const server of await mcpManager.getServersForUser(userId)) {
                if (!server?.id || !server.allConfigured) continue;
                const prefix = `mcp_${server.id}_`.replace(/[^a-zA-Z0-9_]/g, '_');
                for (const name of toolNames) {
                    if (typeof name === 'string' && name.startsWith(prefix)) { out.add(server.id); break; }
                }
            }
        } catch (e) {
            log.warn('[IntegrationTools] MCP trigger availability failed:', e.message);
            return new Set();
        }
        return out;
    }

    /**
     * Append org-scoped custom-integration tools (AI Integration Builder) to a
     * tool list, gated by the caller's effective integration set. Shared by
     * getIntegrationTools (running user) and agentRuntime/agentTools (agent
     * owner) so the gating lives in ONE place.
     *
     *   effectiveIntegrations : Set<string> of granted capability ids, or null.
     *     null ⇒ fail-closed (no custom tools) — the resolver was unavailable/degraded.
     *   orgId : the user's OWN org — custom integrations are org-scoped, so a
     *     missing org (or the '__system__' super-admin scope) means none exist.
     *   Each integration `custom:<uuid>` must be present in the set to expose its
     *   tools_cache entries (already OpenAI-format with cint_-prefixed names,
     *   frozen at activation — including any `_cint` metadata they carry).
     *   The run gate (customIntegrations/mcpLibrary/gate.js) is re-checked here
     *   per row: the builder's dark-ship flag for builder rows, the server-wide
     *   org MCP policy for MCP-library rows. Flipping either off removes
     *   injection without touching callers.
     */
    async function appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId, isToolGranted = null }) {
        if (!effectiveIntegrations) return; // fail closed
        if (!orgId || orgId === '__system__') return; // org-scoped feature — no org, no tools
        try {
            const { loadRunGate } = lazy.mcpLibraryGate();
            const gate = await loadRunGate();
            if (!gate.anyRunnable) return; // both families switched off
            const store = lazy.orgCustomIntegrationStore();
            const rows = await store.listActiveForOrg(orgId);
            for (const row of Array.isArray(rows) ? rows : []) {
                if (!row || !row.id) continue;                            // unidentifiable ⇒ fail closed
                if (!gate.isRunnable(row)) continue;
                if (!effectiveIntegrations.has(`custom:${row.id}`)) continue;
                for (const entry of Array.isArray(row.toolsCache) ? row.toolsCache : []) {
                    const name = entry?.function?.name;
                    if (!name) continue;                                  // unidentifiable ⇒ fail closed
                    // Per-action grants key on `custom:<id>`; the cached tool
                    // definitions do not carry it, so stamp it on for the check.
                    if (isToolGranted && !isToolGranted({ ...entry, _custom: { integrationId: row.id } })) continue;
                    if (!tools.find(x => x.function?.name === name)) tools.push(entry);
                }
            }
        } catch (e) {
            log.warn('[IntegrationTools] Custom integration injection failed:', e.message);
        }
    }

    return { appendMcpTools, availableMcpServerIds, appendCustomIntegrationTools };
}

module.exports = { createExternalToolInjection };

/**
 * @typedef {import('../agentRuntime/toolPolicy/appIndex').ToolDef} ToolDef
 */
