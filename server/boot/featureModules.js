/**
 * The feature side of core/featureModules.js: every feature module core code
 * calls by name, registered as a getter (nothing below loads until first use).
 * Loaded by boot/featureRegistrations.js. The name is the path relative to
 * server/; add a line here when core needs another feature module, and use
 * featureModule(name) there, never a require.
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
    'services/presentationRenderer': () => require('../services/presentationRenderer'),
    'services/documentCompose': () => require('../services/documentCompose'),
    'services/webpageSnapshot': () => require('../services/webpageSnapshot'),
    'services/pwtRunner': () => require('../services/pwtRunner'),
    // automation
    'automation/toolRegistry': () => require('../automation/toolRegistry'),
    'automation/agentCallableTools': () => require('../automation/agentCallableTools'),
    'automation/datatableUsageSync': () => require('../automation/datatableUsageSync'),
    'automation/formTriggerContract': () => require('../automation/formTriggerContract'),
    // agents, projects
    'agents/memory/extractor': () => require('../agents/memory/extractor'),
    'projects/chatModel': () => require('../projects/chatModel'),
});
