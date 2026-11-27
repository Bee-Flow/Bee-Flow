// @typecheck strict
/**
 * The registrations of the first-party module "automation": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/automation.provides.json.
 *
 * jobs/runnerPorts.js is the automation module's (scripts/module-map.json); its
 * datatableRetentionPass reaches the datatables module, which automation requires.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function registerFeatureModules() {
    require('../core/featureModules').registerFeatureModules({
        // automation
        'automation/agentCallableTools': () => require('../automation/agentCallableTools'),
        'automation/datatableUsageSync': () => require('../automation/datatableUsageSync'),
        'automation/formTriggerContract': () => require('../automation/formTriggerContract'),
        // what projects/ (Blueprints, Solution stages, completeness) needs of
        // automation/ and appStudio/: features may not require each other either
        'automation/goLive': () => require('../automation/goLive'),
        'automation/aiActCheck': () => require('../automation/aiActCheck'),
        'automation/subscriptionSync': () => require('../automation/subscriptionSync'),
        'automation/approvalEvents': () => require('../automation/approvalEvents'),
        'automation/approvalNotify': () => require('../automation/approvalNotify'),
        'automation/portability': () => require('../automation/portability'),
        'automation/datatableUsage': () => require('../automation/datatableUsage'),
        'automation/validate': () => require('../automation/validate'),
        'stores/automationStore/webhookDeliveries': () => require('../stores/automationStore/webhookDeliveries'),
    });
}

function registerToolFamily() {
    require('../integrations/toolFamilyAdapters').registerFamilies([
        // Self-scoped: context.automationId is set by the automation runner only.
        { name: 'automation_evolution', order: 440, isTool: (n) => require('../integrations/automationEvolutionTools').isAutomationEvolutionTool(n), execute: (n, a, ctx) => require('../integrations/automationEvolutionTools').executeAutomationEvolutionTool(n, a, { userId: ctx.userId, orgId: ctx.orgId, automationId: ctx.automationId || null, autoSend: ctx.autoSend === true }) },
    ]);
}

function register() {
    contribute('boot/featureModules', registerFeatureModules);
    contribute('boot/featureRegistrations', () => {
        require('../automation/runnerPorts');
        require('../jobs/runnerPorts');
    });
    contribute('integrations/toolFamilies', registerToolFamily);
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerGroupDeps({
        automationEvolutionTools: () => require('../integrations/automationEvolutionToolDefs'),
    }));
    contribute('boot/lateBoundPorts', () => require('../core/tools/automationExecutorPort')
        .setAutomationExecutor((...args) => require('../core/automationRunner').executeAutomation(...args)));
}

module.exports = { register };
