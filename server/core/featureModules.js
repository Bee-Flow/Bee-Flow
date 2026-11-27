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

const { assertProviderNotFailed } = require('../modules/firstParty/moduleState');

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
 *   'stores/studioAppStore': typeof import('../stores/studioAppStore'),
 *   'stores/studioAppData/actionRuns': typeof import('../stores/studioAppData/actionRuns.mts'),
 *   'stores/studioAppData/runLogStore': typeof import('../stores/studioAppData/runLogStore.mts'),
 *   'stores/studioAppData/webhookTriggers': typeof import('../stores/studioAppData/webhookTriggers.mts'),
 *   'stores/studioAppData/runPolicy': typeof import('../stores/studioAppData/runPolicy.mts'),
 *   'stores/automationStore/webhookDeliveries': typeof import('../stores/automationStore/webhookDeliveries'),
 *   'stores/complianceStore': typeof import('../stores/complianceStore'),
 *   'compliance/events': typeof import('../compliance/events'),
 *   'stores/transcriptionStore': typeof import('../stores/transcriptionStore'),
 *   'stores/transcriptCrypto': typeof import('../stores/transcriptCrypto'),
 *   'stores/webpageStore': typeof import('../stores/webpageStore'),
 *   'stores/datatableStore': typeof import('../stores/datatableStore'),
 *   'stores/datatableDbStore': typeof import('../stores/datatableDbStore'),
 *   'stores/githubSyncStore': typeof import('../stores/githubSyncStore'),
 *   'workers/paygDrain': typeof import('../workers/paygDrain'),
 *   'learning/requireTraining': typeof import('../learning/requireTraining'),
 *   'auth/certificateToken': typeof import('../auth/certificateToken'),
 *   'appStudio/approvalWaits': typeof import('../appStudio/approvalWaits.mts'),
 *   'appStudio/mcpBuilder': typeof import('../appStudio/mcpBuilder'),
 *   'auth/webpagePreviewToken': typeof import('../auth/webpagePreviewToken'),
 *   'legal/legalStore': typeof import('../legal/legalStore'),
 *   'automation/mcpBuilder': typeof import('../automation/mcpBuilder'),
 *   'cms/mcp/index': typeof import('../cms/mcp/index'),
 *   'auth/datatableAccess': typeof import('../auth/datatableAccess'),
 *   'stores/automationStore/core': typeof import('../stores/automationStore/core'),
 *   'stores/automationStore': typeof import('../stores/automationStore'),
 *   'stores/playbookStore': typeof import('../stores/playbookStore'),
 *   'routes/transcriptions/shared': typeof import('../routes/transcriptions/shared'),
 *   'projects/completeness': typeof import('../projects/completeness'),
 *   'projects/summary': typeof import('../projects/summary'),
 *   'routes/projects': typeof import('../routes/projects'),
 *   'core/webpages/webpageUsageSync': typeof import('../core/webpages/webpageUsageSync'),
 *   'integrations/nextcloudToolFamily': typeof import('../integrations/nextcloudToolFamily'),
 *   'core/customIntegrations/mcpLibrary/gate': typeof import('../core/customIntegrations/mcpLibrary/gate'),
 *   'stores/orgCustomIntegrationStore': typeof import('../stores/orgCustomIntegrationStore'),
 *   'core/tools/datatableTools': typeof import('../core/tools/datatableTools'),
 *   'compliance/dataPortability/stampExport': typeof import('../compliance/dataPortability/stampExport'),
 *   'compliance/marking': typeof import('../compliance/marking'),
 *   'usecases/notebookArchive': typeof import('../usecases/notebookArchive.mts'),
 *   'core/cowork/runActivity': typeof import('../core/cowork/runActivity.mts'),
 *   'core/cowork/reviewTool': typeof import('../core/cowork/reviewTool.mts'),
 *   'core/cowork/outcomeTool': typeof import('../core/cowork/outcomeTool.mts'),
 *   'core/cowork/habits/habitSignals': typeof import('../core/cowork/habits/habitSignals.mts'),
 *   'stores/coworkStore': typeof import('../stores/coworkStore'),
 *   'core/webpages/sidePanelWebpageContext': typeof import('../core/webpages/sidePanelWebpageContext'),
 *   'integrations/webpageBuilderTools': typeof import('../integrations/webpageBuilderTools'),
 *   'integrations/webpageDbTools': typeof import('../integrations/webpageDbTools'),
 *   'integrations/webpagePlanTool': typeof import('../integrations/webpagePlanTool'),
 *   'core/runEventBus': typeof import('../core/runEventBus'),
 *   'automation/agentBinding': typeof import('../automation/agentBinding'),
 *   'automation/access': typeof import('../automation/access'),
 *   'core/kb/sources/datatable': typeof import('./kb/sources/datatable'),
 *   'core/dataEngine/sources/spreadsheetFile/linkerAuth': typeof import('./dataEngine/sources/spreadsheetFile/linkerAuth'),
 *   'core/dataEngine/sources/spreadsheetFile/providers/index': typeof import('./dataEngine/sources/spreadsheetFile/providers/index'),
 *   'core/dataEngine/sources/spreadsheetFile/providers/documents': typeof import('./dataEngine/sources/spreadsheetFile/providers/documents'),
 *   'core/dataEngine/sources/spreadsheetFile/linkBrowse': typeof import('./dataEngine/sources/spreadsheetFile/linkBrowse'),
 *   'core/dataEngine/sources/spreadsheetFile/linkRelink': typeof import('./dataEngine/sources/spreadsheetFile/linkRelink'),
 *   'core/automationRunner/datatableResolve': typeof import('./automationRunner/datatableResolve'),
 *   'core/dataEngine/datatableRuntime': typeof import('./dataEngine/datatableRuntime'),
 *   'core/dataEngine/provisionManagedTable': typeof import('./dataEngine/provisionManagedTable'),
 *   'core/dataEngine/dataModel/managedTables': typeof import('./dataEngine/dataModel/managedTables'),
 *   'core/dataEngine/datatableLimits': typeof import('./dataEngine/datatableLimits'),
 *   'core/dataEngine/sources/spreadsheetFile/formats/index': typeof import('./dataEngine/sources/spreadsheetFile/formats/index'),
 *   'core/dataEngine/sources/spreadsheetFile/formats/csv': typeof import('./dataEngine/sources/spreadsheetFile/formats/csv'),
 *   'core/dataEngine/sources/spreadsheetFile/formats/sheetjs': typeof import('./dataEngine/sources/spreadsheetFile/formats/sheetjs'),
 *   'core/dataEngine/sources/spreadsheetFile/cells': typeof import('./dataEngine/sources/spreadsheetFile/cells'),
 *   'core/kb/sources/webpage': typeof import('./kb/sources/webpage'),
 *   'stores/dpiaStore': typeof import('../stores/dpiaStore'),
 *   'compliance/kbQueryLogEvidence': typeof import('../compliance/kbQueryLogEvidence'),
 *   'integrations/n8nTools': typeof import('../integrations/n8nTools'),
 *   'services/stripeService': typeof import('../services/stripeService'),
 *   'services/trialService': typeof import('../services/trialService'),
 *   'routes/teamsProviderTest': typeof import('../routes/teamsProviderTest.mts'),
 *   'core/customIntegrations/featureFlag': typeof import('../core/customIntegrations/featureFlag'),
 *   'learning/certificates': typeof import('../learning/certificates'),
 *   'learning/progressValidation': typeof import('../learning/progressValidation'),
 *   'integrations/n8nHttp': typeof import('../integrations/n8nHttp'),
 *   'appStudio/mailboxIdentity': typeof import('../appStudio/mailboxIdentity'),
 *   'usecases/ai/config/erpNlSettingsFields': typeof import('../usecases/ai/config/erpNlSettingsFields'),
 *   'integrations/nmbrsTools': typeof import('../integrations/nmbrsTools'),
 *   'routes/ai/config/firebirdTestRoute': typeof import('../routes/ai/config/firebirdTestRoute'),
 *   'routes/ai/config/frappeCrmTestRoute': typeof import('../routes/ai/config/frappeCrmTestRoute.mts'),
 *   'routes/ai/config/twobaTestRoute': typeof import('../routes/ai/config/twobaTestRoute.mts'),
 *   'usecases/ai/config/scalewayBillingFields': typeof import('../usecases/ai/config/scalewayBillingFields'),
 *   'integrations/gmailTools': typeof import('../integrations/gmailTools'),
 *   'integrations/calendarTools': typeof import('../integrations/calendarTools'),
 *   'integrations/driveTools': typeof import('../integrations/driveTools'),
 *   'integrations/docsTools': typeof import('../integrations/docsTools'),
 *   'integrations/sheetsTools': typeof import('../integrations/sheetsTools'),
 *   'integrations/slidesTools': typeof import('../integrations/slidesTools'),
 *   'integrations/contactsTools': typeof import('../integrations/contactsTools'),
 *   'integrations/keepTools': typeof import('../integrations/keepTools'),
 *   'integrations/googleGroupsTools': typeof import('../integrations/googleGroupsTools'),
 *   'integrations/mapsTools': typeof import('../integrations/mapsTools'),
 *   'integrations/firefliesTools': typeof import('../integrations/firefliesTools'),
 *   'integrations/youtrackTools': typeof import('../integrations/youtrackTools'),
 *   'integrations/signrequestTools': typeof import('../integrations/signrequestTools'),
 *   'integrations/gammaTools': typeof import('../integrations/gammaTools'),
 *   'integrations/scalewayBillingTools': typeof import('../integrations/scalewayBillingTools'),
 *   'integrations/linkedinTools': typeof import('../integrations/linkedinTools'),
 *   'integrations/withingsTools': typeof import('../integrations/withingsTools'),
 *   'integrations/githubTools': typeof import('../integrations/githubTools'),
 *   'integrations/n8nWorkflowTools': typeof import('../integrations/n8nWorkflowTools'),
 *   'integrations/afasTools': typeof import('../integrations/afasTools'),
 *   'integrations/vplanTools': typeof import('../integrations/vplanTools'),
 *   'integrations/firebirdTools': typeof import('../integrations/firebirdTools'),
 *   'integrations/frappeCrmTools': typeof import('../integrations/frappeCrmTools.mts'),
 *   'integrations/twobaTools': typeof import('../integrations/twobaTools.mts'),
 *   'integrations/sanctionsTools': typeof import('../integrations/sanctionsTools.mts'),
 *   'integrations/outlookTools': typeof import('../integrations/outlookTools'),
 *   'integrations/msCalendarTools': typeof import('../integrations/msCalendarTools'),
 *   'integrations/oneDriveTools': typeof import('../integrations/oneDriveTools'),
 *   'integrations/msContactsTools': typeof import('../integrations/msContactsTools'),
 *   'integrations/automationEvolutionToolDefs': typeof import('../integrations/automationEvolutionToolDefs'),
 *   'integrations/nextcloudTools': typeof import('../integrations/nextcloudTools'),
 *   'integrations/nextcloudCalendarTools': typeof import('../integrations/nextcloudCalendarTools'),
 *   'integrations/nextcloudContactsTools': typeof import('../integrations/nextcloudContactsTools'),
 *   'integrations/nextcloudDeckTools': typeof import('../integrations/nextcloudDeckTools'),
 *   'integrations/nextcloudTalkTools': typeof import('../integrations/nextcloudTalkTools'),
 *   'integrations/nextcloudTasksTools': typeof import('../integrations/nextcloudTasksTools'),
 *   'integrations/nextcloudNotesTools': typeof import('../integrations/nextcloudNotesTools'),
 *   'integrations/nextcloudMailTools': typeof import('../integrations/nextcloudMailTools'),
 *   'integrations/nextcloudActivityTools': typeof import('../integrations/nextcloudActivityTools'),
 *   'integrations/nextcloudNotificationsTools': typeof import('../integrations/nextcloudNotificationsTools'),
 *   'integrations/nextcloudTablesTools': typeof import('../integrations/nextcloudTablesTools'),
 *   'integrations/nextcloudFormsTools': typeof import('../integrations/nextcloudFormsTools'),
 *   'integrations/nextcloudTeamsTools': typeof import('../integrations/nextcloudTeamsTools'),
 *   'integrations/nextcloudStatusTools': typeof import('../integrations/nextcloudStatusTools'),
 *   'integrations/webpageAutomationTools': typeof import('../integrations/webpageAutomationTools'),
 *   'integrations/transcriptionTools': typeof import('../integrations/transcriptionTools'),
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
 * The module, or null when it is not registered and no failed module declared
 * it (an absent module). A name whose declared provider failed to load throws
 * a ModuleFailedError (code 'MODULE_FAILED'): a broken module never looks absent.
 * @template {keyof FeatureModuleMap} K
 * @param {K} name
 * @returns {FeatureModuleMap[K] | null}
 */
function optionalFeatureModule(name) {
    let get = getters.get(name);
    if (!get) {
        // A miss is only an answer once the modules have registered their names. The server and the
        // test preload load boot/featureModules.js, which opens this channel; a script or the
        // migration runner may not, and would otherwise see every module as absent.
        require('../modules/firstParty/registrationChannels').ensureOpen('boot/featureModules');
        get = getters.get(name);
    }
    if (get) return get();
    assertProviderNotFailed('featureModules', name);
    return null;
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

module.exports = { registerFeatureModules, featureModule, optionalFeatureModule, hasFeatureModule, featureModuleNames, _featureModuleGetter, _clearFeatureModulesForTests };
