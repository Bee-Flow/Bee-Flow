// @typecheck strict
/**
 * The feature side of core/featureModules.js: every feature module core code
 * (or another feature) calls by name, registered as a getter (nothing below
 * loads until first use).
 * Loaded by boot/featureRegistrations.js. The name is the path relative to
 * server/; add a line here when core, or a feature, needs another feature's module,
 * and use featureModule(name) there, never a require.
 *
 * Only the core's modules are listed here. A first-party module registers its own
 * in its firstParty/<id>.register.js, contributed to the channel 'boot/featureModules'
 * (modules/firstParty/registrationChannels.js) that this file opens once its own
 * registrations are in, so requiring this file still fills the registry with every
 * module that is present.
 */

'use strict';

const { registerFeatureModules } = require('../core/featureModules');

registerFeatureModules({
    // chat turn, tasks, custom integrations, KB
    'integrations/agentSearchTools': () => require('../integrations/agentSearchTools'),
    // web search for App Studio AI steps (appStudio/aiWebSearch.mts, aiCapabilities.mts)
    'integrations/agentSearchEgress': () => require('../integrations/agentSearchEgress'),
    'integrations/webSearchAvailability': () => require('../integrations/webSearchAvailability'),
    // every integration's tool arrays, for getIntegrationTools
    'integrations/coreToolsets': () => require('../integrations/coreToolsets'),
    // filling in a template in a project's team chat (projects/chatTemplateFillTools.mts)
    'integrations/templateFillTools': () => require('../integrations/templateFillTools.mts'),
    'integrations/templateFillToolDefs': () => require('../integrations/templateFillToolDefs.mts'),
    // documents, webpages, KB
    'services/browserProvider': () => require('../services/browserProvider'),
    'services/email/draft': () => require('../services/email/draft.mts'),
    'services/presentationRenderer': () => require('../services/presentationRenderer'),
    'services/documentCompose': () => require('../services/documentCompose'),
    'services/pwtRunner': () => require('../services/pwtRunner'),
    // automation
    'automation/toolRegistry': () => require('../automation/toolRegistry'),
    // agents
    'agents/memory/extractor': () => require('../agents/memory/extractor'),
});

require('../modules/firstParty/registrationChannels').openChannel('boot/featureModules');
