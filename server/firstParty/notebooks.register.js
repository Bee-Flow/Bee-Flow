// @typecheck strict
/**
 * The registrations of the first-party module "notebooks": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/notebooks.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilyAdapters').ModuleToolFamily} ModuleToolFamily */
/** @typedef {import('../integrations/toolFamilies').ToolArgs} ToolArgs */
/** @typedef {import('../integrations/toolFamilies').ToolCtx} ToolCtx */
/**
 * @typedef {{ hasPermission: typeof import('../auth/permissions').hasPermission,
 *   executeWorkspaceTool: typeof import('../integrations/workspaceTools').executeWorkspaceTool }} NotebookDeps
 *   bound when the family registers, as the requires at the top of integrations/toolFamilies.js were
 */

// ─── Notebook Tools (formerly Workspace) ───────────────────────

/**
 * BFSF-207 backstop: notebook tools are entitlement-gated at registration;
 * re-check at dispatch so no other injection path can execute them. Mirrors
 * registration's org resolution (the user's own org — context.orgId is absent
 * in agent chat and may be the LENDER's org under connection lending).
 * Returns the refusal, or null when the user may use notebooks.
 * @param {NotebookDeps['hasPermission']} hasPermission
 * @param {string} userId
 * @param {Express.Session} session
 */
async function notebookRefusal(hasPermission, userId, session) {
    try {
        const { hasCapability } = require('../core/entitlements/entitlements');
        let resolveOrgId = null;
        try { resolveOrgId = (await require('../stores/userStore').getUser(userId))?.organizationId || null; } catch (_) { require('../utils/bestEffort').fallback('integrations/toolFamilies:notebookRefusal', _); /* user lookup failed, the capability check runs without an org */ }
        const ok = !!userId
            && await hasCapability('notebooks', { userId, orgId: resolveOrgId, session })
            && await hasPermission(userId, 'use_notebooks', session);
        if (!ok) {
            return { error: 'The notebook is not available for this user — the notebooks feature is not included in their plan or has not been enabled for them. Briefly let the user know the notebook is unavailable and continue helping them directly in chat.' };
        }
        return null;
    } catch (_) {
        return { error: 'The notebook is temporarily unavailable. Continue helping the user directly in chat.' };
    }
}

/**
 * @param {NotebookDeps} deps
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeNotebook({ hasPermission, executeWorkspaceTool }, toolName, toolArgs, context) {
    const { session } = context;
    const userId = /** @type {string} */ (context.userId);
    const refusal = await notebookRefusal(hasPermission, userId, /** @type {Express.Session} */ (session));
    if (refusal) return refusal;
    // `userId` is REQUIRED here: the tool's cross-user guard keys off it, and
    // conversationId arrives from the client, so without a caller identity the
    // guard has nothing to compare against and every notebook is reachable.
    return await executeWorkspaceTool(toolName, toolArgs, {
        conversationId: /** @type {string | undefined} */ (context.conversationId),
        agentId: /** @type {string | undefined} */ (context.agentId),
        userId,
        session,
    });
}

function registerToolFamily() {
    const { NOTEBOOK_TOOLS } = require('../core/integrations/notebookToolNames');
    /** @type {NotebookDeps} */
    const deps = { hasPermission: require('../auth/permissions').hasPermission, executeWorkspaceTool: require('../integrations/workspaceTools').executeWorkspaceTool };
    require('../integrations/toolFamilyAdapters').registerFamilies([
        { name: 'notebook', order: 420, isTool: (n) => NOTEBOOK_TOOLS.has(n), execute: (n, a, ctx) => executeNotebook(deps, n, a, ctx) },
    ]);
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // chat turn, tasks, custom integrations, KB
        'integrations/workspaceTools': () => require('../integrations/workspaceTools'),
    }));
    contribute('integrations/toolFamilies', registerToolFamily);
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerToolsets({
        WORKSPACE_TOOLS: require('../integrations/workspaceTools').WORKSPACE_TOOLS,
    }));
}

module.exports = { register };
