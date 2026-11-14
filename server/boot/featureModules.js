// @typecheck strict
/**
 * The feature side of core/featureModules.js: every feature module core code
 * (or another feature) calls by name, registered as a getter (nothing below
 * loads until first use).
 * Loaded by boot/featureRegistrations.js. The name is the path relative to
 * server/; add a line here when core, or a feature, needs another feature's module,
 * and use featureModule(name) there, never a require.
 */

'use strict';

const { registerFeatureModules } = require('../core/featureModules');

registerFeatureModules({
    // chat turn, tasks, custom integrations, KB
    'integrations/workspaceTools': () => require('../integrations/workspaceTools'),
    'integrations/agentSearchTools': () => require('../integrations/agentSearchTools'),
    'integrations/customIntegrationRunner': () => require('../integrations/customIntegrationRunner'),
    // every integration's tool arrays, for getIntegrationTools
    'integrations/coreToolsets': () => require('../integrations/coreToolsets'),
    // documents, webpages, KB
    'services/browserProvider': () => require('../services/browserProvider'),
    'services/email/draft': () => require('../services/email/draft.mts'),
    'services/presentationRenderer': () => require('../services/presentationRenderer'),
    'services/documentCompose': () => require('../services/documentCompose'),
    'services/webpageSnapshot': () => require('../services/webpageSnapshot'),
    'services/pwtRunner': () => require('../services/pwtRunner'),
    // automation
    'automation/toolRegistry': () => require('../automation/toolRegistry'),
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
    'appStudio/definitionGate': () => require('../appStudio/definitionGate.mts'),
    'appStudio/appAssets': () => require('../appStudio/appAssets.mts'),
    'appStudio/portabilityReport': () => require('../appStudio/portabilityReport.mts'),
    'appStudio/automationUsageSync': () => require('../appStudio/automationUsageSync'),
    'appStudio/triggers/deploySync': () => require('../appStudio/triggers/deploySync.mts'),
    // agents, projects
    'agents/memory/extractor': () => require('../agents/memory/extractor'),
    'projects/chatModel': () => require('../projects/chatModel'),
});
