// @typecheck
/**
 * Feature modules: the few feature-owned modules core code calls, looked up by
 * name instead of required.
 *
 * Core may not require a feature (server/ARCHITECTURE.md), yet a chat turn has
 * to reach the workspace tools, a rendered PDF the headless browser, and the
 * tool dispatcher the automation step tools. boot/featureModules.js registers
 * each of those modules here as a GETTER (the module's path relative to
 * server/ is its name) and core asks for it where it needs it:
 *
 *   const { featureModule } = require('../featureModules');
 *   const browserProvider = featureModule('services/browserProvider');
 *
 * The getter is called on every lookup, so the module behind it loads on first
 * use and a test's require.cache stub of it is what a lookup returns. Same
 * shape as core/integrations/integrationClients.js (provider clients) and
 * core/automationRunner/featurePorts.js (the runner's ports); this one is for
 * "the module itself", where there is no narrower port worth naming.
 *
 * index.js loads boot/featureRegistrations.js, which loads the registration. A
 * test that drives a code path through one of these loads
 * boot/featureModules.js itself.
 */

'use strict';

/**
 * Every module that can be asked for: its name (the path relative to server/)
 * and what that name returns. featureModule() takes one of these names and
 * returns the module that goes with it, so a misspelt name is a type error
 * where it is written, and the caller sees the module's own types.
 * boot/featureModules.js registers a getter under each name;
 * boot/featureModules.test.js holds the registrations and the names the tree
 * asks for against each other.
 *
 * Types only: an `import()` inside a comment loads nothing, so core still
 * requires no feature.
 *
 * Three names still return `any`, as every name did before this map: with the
 * module's own types a caller of each shows type errors that are that
 * caller's to settle, not this file's. Give the name its `typeof import(...)`
 * once that caller is clean:
 *   integrations/customIntegrationRunner   integrations/customIntegrationSteps.js,
 *                                          through core/customIntegrations/customMcpClient.js
 *   services/presentationRenderer          integrations/presentationTools.js
 *   services/documentCompose               core/documents/renderFilledDocument.js
 *
 * @typedef {{
 *   'integrations/workspaceTools': typeof import('../integrations/workspaceTools'),
 *   'integrations/agentSearchTools': typeof import('../integrations/agentSearchTools'),
 *   'integrations/agentSearchEgress': typeof import('../integrations/agentSearchEgress'),
 *   'integrations/webSearchAvailability': typeof import('../integrations/webSearchAvailability'),
 *   'integrations/customIntegrationRunner': any,
 *   'integrations/coreToolsets': typeof import('../integrations/coreToolsets'),
 *   'services/browserProvider': typeof import('../services/browserProvider'),
 *   'services/email/draft': typeof import('../services/email/draft.mts'),
 *   'services/presentationRenderer': any,
 *   'services/documentCompose': any,
 *   'services/webpageSnapshot': typeof import('../services/webpageSnapshot'),
 *   'services/pwtRunner': typeof import('../services/pwtRunner'),
 *   'automation/toolRegistry': typeof import('../automation/toolRegistry'),
 *   'automation/agentCallableTools': typeof import('../automation/agentCallableTools'),
 *   'automation/datatableUsageSync': typeof import('../automation/datatableUsageSync'),
 *   'automation/formTriggerContract': typeof import('../automation/formTriggerContract'),
 *   'automation/goLive': typeof import('../automation/goLive'),
 *   'automation/aiActCheck': typeof import('../automation/aiActCheck'),
 *   'automation/subscriptionSync': typeof import('../automation/subscriptionSync'),
 *   'automation/approvalEvents': typeof import('../automation/approvalEvents'),
 *   'automation/approvalNotify': typeof import('../automation/approvalNotify'),
 *   'automation/portability': typeof import('../automation/portability'),
 *   'automation/datatableUsage': typeof import('../automation/datatableUsage'),
 *   'automation/validate': typeof import('../automation/validate'),
 *   'appStudio/definitionGate': typeof import('../appStudio/definitionGate.mts'),
 *   'appStudio/appAssets': typeof import('../appStudio/appAssets.mts'),
 *   'appStudio/portabilityReport': typeof import('../appStudio/portabilityReport.mts'),
 *   'appStudio/automationUsageSync': typeof import('../appStudio/automationUsageSync'),
 *   'appStudio/triggers/deploySync': typeof import('../appStudio/triggers/deploySync.mts'),
 *   'agents/memory/extractor': typeof import('../agents/memory/extractor'),
 *   'projects/chatModel': typeof import('../projects/chatModel'),
 * }} FeatureModuleMap
 */

/** name -> () => module */
const getters = new Map();

/** Register (or replace) modules: `{ 'services/browserProvider': () => require(...), ... }`. */
function registerFeatureModules(map) {
    for (const [name, get] of Object.entries(map || {})) {
        if (typeof get !== 'function') throw new TypeError(`registerFeatureModules(${name}): a module is registered as a getter function`);
        getters.set(name, get);
    }
}

/**
 * The module, or a thrown Error naming what was not loaded.
 * @template {keyof FeatureModuleMap} K
 * @param {K} name
 * @returns {FeatureModuleMap[K]}
 */
function featureModule(name) {
    const get = getters.get(name);
    if (!get) {
        throw new Error(`feature module "${name}" is not registered (boot/featureModules.js was not loaded)`);
    }
    return get();
}

/**
 * The registered getter (a test seam: testUtils/stubRequire.js swaps it and puts it back).
 * @param {string} name
 */
function _featureModuleGetter(name) {
    return getters.get(name);
}

function hasFeatureModule(name) {
    return getters.has(name);
}

/**
 * Every registered name (boot/featureModules.test.js holds them against the names the tree asks for).
 * @returns {string[]}
 */
function featureModuleNames() {
    return [...getters.keys()];
}

/** Test seam: drop one module, or all of them. */
function _clearFeatureModulesForTests(name) {
    if (name) getters.delete(name);
    else getters.clear();
}

module.exports = { registerFeatureModules, featureModule, hasFeatureModule, featureModuleNames, _featureModuleGetter, _clearFeatureModulesForTests };
