/**
 * Webpage Bridge Tools — studio-AI tools that let the author manage which
 * platform capabilities are exposed to the running page via
 * window.beeflowAI / .beeflowAutomations / .beeflowIntegrations.
 *
 * Each grant is stored in webpages.bridge_grants. The bridges run
 * acts-as-author, so this allowlist is the sole opt-in surface — viewers
 * cannot bypass it.
 *
 * Tools:
 *   webpage_grant_ai             { enabled, groundOnPage, defaultTier? }
 *   webpage_list_my_automations  → author's owned active automations
 *   webpage_grant_automation     { automationId, label? }
 *   webpage_revoke_automation    { automationId }
 *   webpage_list_my_integrations → author's permitted+connected integration tools
 *   webpage_grant_integration    { tool, fixedArgs?, label? }
 *   webpage_revoke_integration   { tool }
 *
 * The grant/revoke/list branches delegate to integrations/webpageGrants.js —
 * the SAME module the owner REST endpoints (routes/webpagesGrants.js) use, so
 * the AI and the IDE panel share one availability/ownership policy. The AI
 * tool contract stays "return { error } on failure", so thrown grantErrors
 * (which carry HTTP statuses for the REST layer) are flattened back.
 */

const webpageStore = require('../stores/webpageStore');
const webpageGrants = require('./webpageGrants');

// Chat tools signal failure as a returned object, never a throw. grantError
// carries { status, code, provider } for the REST layer — the code/provider
// ride along so the studio AI can tell the author WHICH app to connect.
function bridgeErr(e) {
    if (!e) return { error: 'Unknown error' };
    return {
        error: e.message || String(e),
        ...(e.code ? { code: e.code } : {}),
        ...(e.provider ? { provider: e.provider } : {}),
    };
}

const WEBPAGE_BRIDGE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_grant_ai',
            description: 'Configure the AI bridge for this webpage (window.beeflowAI). Controls whether the page can chat the platform LLM, whether the page\'s own knowledge is auto-injected as context, and whether ANONYMOUS visitors of an external share link can use the AI (spending the author\'s LLM budget).',
            parameters: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', description: 'Master on/off for window.beeflowAI. Default: true.' },
                    groundOnPage: { type: 'boolean', description: 'When true, the AI auto-pulls the page\'s knowledge_base_ids and uploaded sources as context. Default: true.' },
                    defaultTier: { type: 'string', description: 'Default model tier used when the page does not specify one. e.g. "fast", "smart", "thinking".' },
                    publicEnabled: { type: 'boolean', description: 'Allow anonymous visitors of an external SHARE LINK to use the AI. Default: false. Spends the author\'s LLM budget for strangers — enable only intentionally. Only applies to react-mui webpages; chat/stream only (no DB/automations/tools).' },
                    publicGroundOnPage: { type: 'boolean', description: 'When true, anonymous share visitors get the page knowledge auto-injected as context. Default: false. WARNING: exposes the page\'s knowledge base content to anyone with the link.' },
                    publicSpendCapUsd: { type: 'number', description: 'Rolling 24h estimated-cost ceiling (USD) for anonymous share AI on this page. Beyond it, public AI returns a usage-limit error until the window rolls. Clamped to a platform max.' },
                    publicDefaultTier: { type: 'string', description: 'Model tier forced for anonymous share visitors (their requests cannot pick a more expensive tier). Default: "fast".' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_list_my_automations',
            description: 'List the page author\'s own automations (studio routines). Call before granting one to a page.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_grant_automation',
            description: 'Allow the running page to trigger one of the author\'s automations via window.beeflowAutomations.run(). Acts-as-author at runtime.',
            parameters: {
                type: 'object',
                properties: {
                    automationId: { type: 'string', description: 'ID of an automation owned by the page author.' },
                    label: { type: 'string', description: 'Optional display label; defaults to the automation title.' },
                },
                required: ['automationId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_revoke_automation',
            description: 'Remove an automation grant from this webpage.',
            parameters: {
                type: 'object',
                properties: { automationId: { type: 'string' } },
                required: ['automationId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_list_my_integrations',
            description: 'List the page author\'s permitted and connected integration tools (Gmail send, Slack post, Sheets append, …). Call before granting a tool to a page.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_grant_integration',
            description: 'Allow the running page to call one specific integration tool via window.beeflowIntegrations.run(). Acts-as-author. ALWAYS use fixedArgs to pin sensitive fields (channel, recipient, sheet ID) the visitor must not be allowed to override.',
            parameters: {
                type: 'object',
                properties: {
                    tool: { type: 'string', description: 'Exact tool name, e.g. "slack_post_message", "gmail_send", "sheets_append_row".' },
                    fixedArgs: { type: 'object', description: 'Args the author pins server-side. These ALWAYS win over viewer-supplied args at call time. Use for channel, recipient, document/sheet IDs, etc.' },
                    label: { type: 'string', description: 'Optional display label.' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_revoke_integration',
            description: 'Remove an integration tool grant from this webpage.',
            parameters: {
                type: 'object',
                properties: { tool: { type: 'string' } },
                required: ['tool'],
            },
        },
    },
];

const TOOL_NAMES = new Set(WEBPAGE_BRIDGE_TOOLS.map(t => t.function.name));

function isBridgeTool(name) {
    return TOOL_NAMES.has(name);
}

async function executeBridgeTool(toolName, args, { webpageId, userId, session }) {
    if (toolName === 'webpage_grant_ai') {
        // Patch merges onto the current ai slice so a partial call (e.g. only
        // publicEnabled) doesn't clobber existing enabled/groundOnPage.
        const current = await webpageStore.getBridgeGrants(webpageId);
        const aiPatch = { ...current.ai };
        if (typeof args.enabled === 'boolean') aiPatch.enabled = args.enabled;
        if (typeof args.groundOnPage === 'boolean') aiPatch.groundOnPage = args.groundOnPage;
        if (typeof args.defaultTier === 'string') aiPatch.defaultTier = args.defaultTier;
        if (typeof args.publicEnabled === 'boolean') aiPatch.publicEnabled = args.publicEnabled;
        if (typeof args.publicGroundOnPage === 'boolean') aiPatch.publicGroundOnPage = args.publicGroundOnPage;
        if (typeof args.publicSpendCapUsd === 'number') aiPatch.publicSpendCapUsd = args.publicSpendCapUsd;
        if (typeof args.publicDefaultTier === 'string') aiPatch.publicDefaultTier = args.publicDefaultTier;
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, { ai: aiPatch });
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, ai: merged.ai };
    }

    if (toolName === 'webpage_list_my_automations') {
        const automations = await webpageGrants.listAuthorAutomations({ userId });
        return { automations };
    }

    if (toolName === 'webpage_grant_automation') {
        try {
            const r = await webpageGrants.grantAutomation({ webpageId, userId, automationId: args.automationId, label: args.label });
            return { success: true, automationId: r.automationId, title: r.title };
        } catch (e) { return bridgeErr(e); }
    }

    if (toolName === 'webpage_revoke_automation') {
        try {
            await webpageGrants.revokeAutomation({ webpageId, userId, automationId: args.automationId });
            return { success: true, removed: args.automationId };
        } catch (e) { return bridgeErr(e); }
    }

    if (toolName === 'webpage_list_my_integrations') {
        // Fail-closed: when availability discovery fails the helper returns
        // { integrations: [], discoveryFailed: true } — the AI reports it can't
        // check connections rather than offering tools that would fail at runtime.
        return webpageGrants.listAvailableIntegrations({ userId, session });
    }

    if (toolName === 'webpage_grant_integration') {
        try {
            const r = await webpageGrants.grantIntegration({
                webpageId, userId, session,
                tool: args.tool, fixedArgs: args.fixedArgs, label: args.label,
            });
            return { success: true, tool: r.tool, integrationId: r.integrationId, granted: r.grants.integrations.map(g => g.tool) };
        } catch (e) { return bridgeErr(e); }
    }

    if (toolName === 'webpage_revoke_integration') {
        try {
            const r = await webpageGrants.revokeIntegration({ webpageId, userId, tool: args.tool });
            return { success: true, removed: r.removed, granted: r.grants.integrations.map(g => g.tool) };
        } catch (e) { return bridgeErr(e); }
    }

    return { error: `Unknown bridge tool: ${toolName}` };
}

module.exports = {
    WEBPAGE_BRIDGE_TOOLS,
    isBridgeTool,
    executeBridgeTool,
};
