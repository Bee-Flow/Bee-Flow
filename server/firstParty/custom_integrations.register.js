// @typecheck strict
/**
 * The registrations of the first-party module "custom_integrations": its rows of the core's
 * registries, each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/custom_integrations.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilies').ToolArgs} ToolArgs */
/** @typedef {import('../integrations/toolFamilies').ToolCtx} ToolCtx */

// ─── Custom Integrations (AI Integration Builder) ──────────────
// Org-scoped cint_<slug>_<tool> calls go straight to the hardened runner
// — org match, status, capability backstop, origin pin, SSRF re-check,
// method gate and secret scrub all live there. First in the walk (order 0)
// so no prefix collision can shadow it.
// `unattended`: context.autoSend is the dispatch-side headless marker —
// the automation runner sets it on LIVE automation runs and webpageApiRuntime
// sets it on backend handler calls. The custom-integration runner refuses
// unattended===true outright for now, and the capability backstop still
// gates every call regardless of path.
//
// The task/cowork runner needs the two halves apart. It must auto-send
// email (nobody is there to approve a draft — see the aiTaskRunner call
// site), but flipping its custom-integration calls to unattended would
// turn working automations into refusals, which is a policy change and not
// this fix's business. So `unattended` can be set explicitly and only
// falls back to autoSend when it wasn't.
/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeCustomIntegration(toolName, toolArgs, context) {
    return await require('../integrations/customIntegrationRunner').executeCustomIntegrationTool(toolName, toolArgs, {
        userId: context.userId,
        unattended: context.unattended !== undefined ? !!context.unattended : !!context.autoSend,
    });
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // chat turn, tasks, custom integrations, KB
        'integrations/customIntegrationRunner': () => require('../integrations/customIntegrationRunner'),
    }));
    contribute('integrations/toolFamilies', () => {
        // `parseName` gives core's progressive disclosure the cint_<slug>_<tool> grammar.
        require('../core/tools/toolFamilyRegistry').registerToolFamily({ name: 'custom_integration', order: 0, isTool: (/** @type {string} */ n) => require('../integrations/customIntegrationRunner').isCustomIntegrationTool(n), execute: executeCustomIntegration, parseName: (/** @type {string} */ n) => require('../integrations/customIntegrationRunner').parsePrefixedName(n) });
    });
    contribute('integrations/runnerPorts', () => require('../core/automationRunner/featurePorts').registerRunnerPorts({
        // http_request credentials of a custom integration.
        customIntegrations: {
            renderAuthValue: (/** @type {Parameters<typeof import('../integrations/customIntegrationRunner').renderAuthValue>} */ ...args) => require('../integrations/customIntegrationRunner').renderAuthValue(...args),
        },
    }));
}

module.exports = { register };
