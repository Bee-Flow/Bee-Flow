// @typecheck strict
/**
 * The registrations of the first-party module "int_saas": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/int_saas.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilyAdapters').ModuleToolFamily} ModuleToolFamily */
/** @typedef {import('../integrations/toolFamilies').ToolArgs} ToolArgs */
/** @typedef {import('../integrations/toolFamilies').ToolCtx} ToolCtx */
/**
 * @typedef {{ hasPermission: typeof import('../auth/permissions').hasPermission,
 *   getN8nToolPermission: typeof import('../integrations/n8nWorkflowTools').getN8nToolPermission,
 *   executeN8nWorkflowTool: typeof import('../integrations/n8nWorkflowTools').executeN8nWorkflowTool }} N8nWorkflowDeps
 *   bound when the families register, as the requires at the top of integrations/toolFamilies.js were
 */

// ─── n8n workflow tools ────────────────────────────────────────
// Read-only n8n tools are implicit for every member of an org with n8n
// configured (umbrella 'n8n' integration toggle gates injection). Only
// the write/execute bucket is permission-gated via modify_n8n_workflows.
// Non-LLM callers (pipelines, schedules) also flow through here, so we
// re-check writes as defense-in-depth vs. the registration-time filter.
/**
 * @param {N8nWorkflowDeps} deps
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeN8nWorkflow({ hasPermission, getN8nToolPermission, executeN8nWorkflowTool }, toolName, toolArgs, context) {
    const { userId, session, orgId } = context;
    if (userId && getN8nToolPermission(toolName) === 'modify_n8n_workflows') {
        const granted = await hasPermission(userId, 'modify_n8n_workflows', session);
        if (!granted) {
            return { error: 'You do not have permission to modify n8n workflows. Ask your organisation admin to grant the "Modify n8n Workflows" permission.' };
        }
    }
    return await executeN8nWorkflowTool(toolName, toolArgs, /** @type {string} */ (orgId));
}

/** @returns {ModuleToolFamily[]} */
function toolFamilies() {
    const { byUser, bySession } = require('../integrations/toolFamilyAdapters');
    const { hasPermission } = require('../auth/permissions');
    const { isFirefliesTool, executeFirefliesTool } = require('../integrations/firefliesTools');
    const { isYouTrackTool, executeYouTrackTool } = require('../integrations/youtrackTools');
    const { isSignRequestTool, executeSignRequestTool } = require('../integrations/signrequestTools');
    const { isGammaTool, executeGammaTool } = require('../integrations/gammaTools');
    const { isScalewayBillingTool, executeScalewayBillingTool } = require('../integrations/scalewayBillingTools');
    const { isN8nTool, executeN8nTool } = require('../integrations/n8nTools');
    const { isN8nWorkflowTool, executeN8nWorkflowTool, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
    const { isLinkedInTool, executeLinkedInTool } = require('../integrations/linkedinTools');
    const { isGitHubTool, executeGitHubTool } = require('../integrations/githubTools');
    /** @type {N8nWorkflowDeps} */
    const n8nWorkflow = { hasPermission, getN8nToolPermission, executeN8nWorkflowTool };
    return [
        { name: 'fireflies', order: 100, isTool: isFirefliesTool, execute: byUser(executeFirefliesTool) },
        { name: 'youtrack', order: 120, isTool: isYouTrackTool, execute: byUser(executeYouTrackTool) },
        { name: 'signrequest', order: 130, isTool: isSignRequestTool, execute: byUser(executeSignRequestTool) },
        { name: 'gamma', order: 140, isTool: isGammaTool, execute: byUser(executeGammaTool) },
        { name: 'scaleway_billing', order: 180, isTool: isScalewayBillingTool, execute: (n, a, ctx) => executeScalewayBillingTool(n, a, ctx.userId, { automationId: ctx.automationId || null, runScope: ctx.runScope || null }) }, // the run scope: keep the PDF for this run, hand on a generated_file handle
        // Lazily required: withingsTools pulls in automationAuth (and through it the credential vault), which nothing else on this hot path needs.
        { name: 'withings', order: 190, isTool: (n) => require('../integrations/withingsTools').isWithingsTool(n), execute: (n, a, ctx) => require('../integrations/withingsTools').executeWithingsTool(n, a, ctx.userId) },
        // Before 'n8n': every workflow tool is an n8n_* name too.
        { name: 'n8n_workflow', order: 290, isTool: isN8nWorkflowTool, execute: (n, a, ctx) => executeN8nWorkflow(n8nWorkflow, n, a, ctx) },
        // Webhook-trigger tools are implicit for every member once the org has n8n
        // configured — gated only by the umbrella 'n8n' integration toggle at
        // injection time (see core/integrations/integrationTools.js).
        { name: 'n8n', order: 300, isTool: isN8nTool, execute: (n, a, ctx) => executeN8nTool(n, a, ctx.orgId, ctx.attachments) },
        { name: 'linkedin', order: 490, isTool: isLinkedInTool, execute: bySession(executeLinkedInTool) },
        { name: 'github', order: 500, isTool: isGitHubTool, execute: byUser(executeGitHubTool) },
    ];
}

function registerToolsets() {
    const { registerToolsets: toolsets, registerGroupDeps } = require('../integrations/coreToolsets');
    const { buildN8nTools } = require('../integrations/n8nTools');
    const { N8N_WORKFLOW_TOOLS, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
    toolsets({
        FIREFLIES_TOOLS: require('../integrations/firefliesTools').FIREFLIES_TOOLS,
        YOUTRACK_TOOLS: require('../integrations/youtrackTools').YOUTRACK_TOOLS,
        SIGNREQUEST_TOOLS: require('../integrations/signrequestTools').SIGNREQUEST_TOOLS,
        GAMMA_TOOLS: require('../integrations/gammaTools').GAMMA_TOOLS,
        SCALEWAY_BILLING_TOOLS: require('../integrations/scalewayBillingTools').SCALEWAY_BILLING_TOOLS,
        N8N_WORKFLOW_TOOLS,
        LINKEDIN_TOOLS: require('../integrations/linkedinTools').LINKEDIN_TOOLS,
        WITHINGS_TOOLS: require('../integrations/withingsTools').WITHINGS_TOOLS,
        GITHUB_TOOLS: require('../integrations/githubTools').GITHUB_TOOLS,
    });
    registerGroupDeps({ buildN8nTools, N8N_WORKFLOW_TOOLS, getN8nToolPermission });
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/githubSyncStore': () => require('../stores/githubSyncStore'),
        'integrations/n8nTools': () => require('../integrations/n8nTools'),
        'integrations/n8nHttp': () => require('../integrations/n8nHttp'),
        'usecases/ai/config/scalewayBillingFields': () => require('../usecases/ai/config/scalewayBillingFields'),
    }));
    contribute('integrations/toolFamilies', () => require('../integrations/toolFamilyAdapters').registerFamilies(toolFamilies()));
    contribute('integrations/coreToolsets', registerToolsets);
    contribute('integrations/integrationClients', () => require('../core/integrations/integrationClients').registerIntegrationClients({
        github: () => require('../integrations/githubTools'),
        youtrack: () => require('../integrations/youtrackTools'),
    }));
    contribute('boot/lateBoundPorts', () => require('../stores/resourceSyncPort')
        .setAutoSyncResource((orgId, resourceType, resourceId, action) => require('../services/githubSyncService').autoSyncResource(orgId, resourceType, resourceId, action)));
}

module.exports = { register };
