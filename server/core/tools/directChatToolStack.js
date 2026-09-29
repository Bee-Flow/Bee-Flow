/**
 * Direct Chat Tool Stack — shared builder.
 *
 * Returns the tool array a direct-chat-style LLM call should see, assembled
 * from:
 *   - Components flagged for direct chat (or tier-specific tool list)
 *   - Integration tools (agent_search, gmail_*, calendar_*, drive_*, …)
 *   - Org-gated MCP tools
 *
 * Used by:
 *   - server/routes/ai/directChat.js (regular direct chat)
 *   - server/core/swarms/swarmRuntime.js (each swarm worker)
 *
 * Keeping one builder means the Swarm tier's workers see exactly the same
 * integrations the user has in plain direct chat — no drift, no separate
 * configuration surface.
 */

const componentManager = require('../cms/componentManager');
const configStore = require('../../stores/configStore');
const { getIntegrationTools } = require('../integrations/integrationTools');
const log = require('../../telemetry/log');

async function buildDirectChatToolStack({ userId, session, isAdmin = false, resolvedTier = null, strict = false, extraEnabledApps = null } = {}) {
    // ── Components enabled for direct chat (or tier-specific list) ──
    const allComponents = componentManager.getComponents();
    const tierToolsConfig = await configStore.getConfig('direct_chat_tier_tools');
    const enabledToolIds = tierToolsConfig && resolvedTier ? tierToolsConfig[resolvedTier] : null;
    const tools = allComponents
        .filter(c => {
            if (enabledToolIds) return enabledToolIds.includes(c.id);
            return c.definition?.directChatEnabled === true;
        })
        .map(c => {
            const inputDefs = c.definition?.inputs || {};
            const visibleInputs = Object.entries(inputDefs)
                .filter(([, conf]) => {
                    if (typeof conf !== 'object') return true;
                    return !conf.secure && conf.default === undefined;
                });
            return {
                type: 'function',
                function: {
                    name: c.id,
                    description: c.definition.description || c.definition.name || c.id,
                    parameters: {
                        type: 'object',
                        properties: visibleInputs.reduce((acc, [key, conf]) => {
                            acc[key] = {
                                type: (typeof conf === 'object' ? conf.type : conf) || 'string',
                                description: (typeof conf === 'object' ? conf.description : '') || '',
                            };
                            return acc;
                        }, {}),
                        required: visibleInputs
                            .filter(([, conf]) => typeof conf === 'object' && conf.required)
                            .map(([key]) => key),
                    },
                },
            };
        });

    // ── Integration tools (agent_search, gmail, calendar, drive, …) ──
    let n8nOrgId = null;
    try {
        // extraEnabledApps: skill-scoped app enablement (bypasses only the
        // per-user app toggle; entitlement/credential gates stay inside).
        const integrations = await getIntegrationTools({ userId, session, isAdmin, extraEnabledApps });
        n8nOrgId = integrations?.n8nOrgId || null;
        for (const tool of integrations?.tools || []) {
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    } catch (e) {
        // strict: the caller wants an integration-tools failure to fail the
        // whole turn (direct chat's historical behavior). Default: degrade to
        // component tools only (swarm workers).
        if (strict) throw e;
        log.warn('[DirectChatToolStack] integration tools failed:', e.message);
    }
    // MCP-server tools are injected inside getIntegrationTools (they are
    // integrations now, gated by the same effective.integration set).

    return { tools, n8nOrgId };
}

module.exports = { buildDirectChatToolStack };
