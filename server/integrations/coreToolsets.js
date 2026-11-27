// @typecheck strict
/**
 * The integration tool arrays and helpers getIntegrationTools hands to its tool
 * groups (core/integrations/integrationTools.js). Core may not require a
 * feature, so core asks for this module by name (boot/featureModules.js,
 * core/featureModules.js) and gets the toolsets and the feature-side
 * collaborators from here.
 *
 * TOOLSETS is offered in KEY ORDER, and that order is the core's: TOOLSET_KEYS
 * below names every key in its place. The core's own arrays are registered
 * here; a first-party module registers its arrays by key in its
 * firstParty/<id>.register.js (registerToolsets, contributed to the channel
 * 'integrations/coreToolsets' of modules/firstParty/registrationChannels.js,
 * which this file opens once its own are in, so they arrive when this file
 * loads and their arrays load then too). TOOLSETS is built in
 * TOOLSET_KEYS order and skips a key nobody registered (an absent module).
 * GROUP_DEPS the same, in GROUP_DEP_KEYS order (lazy entries stay lazy).
 */

'use strict';

const { AGENT_SEARCH_TOOLS } = require('./agentSearchTools');
const { BROWSE_WEB_TOOLS } = require('./browserFetchTools');
const { REGEX_GENERATOR_TOOLS } = require('./regexGeneratorTools');
const { KB_SEARCH_TOOLS } = require('./kbSearchTools');
const { KB_INGEST_TOOLS } = require('./kbIngestTools');

/** Every toolset key, in the order TOOLSETS offers them. */
const TOOLSET_KEYS = Object.freeze([
    'GMAIL_TOOLS',
    'CALENDAR_TOOLS',
    'DRIVE_TOOLS',
    'DOCS_TOOLS',
    'SHEETS_TOOLS',
    'SLIDES_TOOLS',
    'CONTACTS_TOOLS',
    'KEEP_TOOLS',
    'GOOGLE_GROUPS_TOOLS',
    'FIREFLIES_TOOLS',
    'YOUTRACK_TOOLS',
    'SIGNREQUEST_TOOLS',
    'GAMMA_TOOLS',
    'AFAS_TOOLS',
    'NMBRS_TOOLS',
    'VPLAN_TOOLS',
    'FIREBIRD_TOOLS',
    'FRAPPE_CRM_TOOLS',
    'TWOBA_TOOLS',
    'SANCTIONS_TOOLS',
    'SCALEWAY_BILLING_TOOLS',
    'N8N_WORKFLOW_TOOLS',
    'AGENT_SEARCH_TOOLS',
    'BROWSE_WEB_TOOLS',
    'REGEX_GENERATOR_TOOLS',
    'WORKSPACE_TOOLS',
    'KB_SEARCH_TOOLS',
    'KB_INGEST_TOOLS',
    'MAPS_TOOLS',
    'LINKEDIN_TOOLS',
    'WITHINGS_TOOLS',
    'GITHUB_TOOLS',
    'OUTLOOK_TOOLS',
    'OUTLOOK_READONLY_TOOLS',
    'MS_CALENDAR_TOOLS',
    'ONEDRIVE_TOOLS',
    'MS_CONTACTS_TOOLS',
    'TRANSCRIPTION_TOOLS',
    'NEXTCLOUD_TOOLS',
    // Automation steps only (core/integrations/integrationToolFeatures.js addNextcloudTools).
    'NEXTCLOUD_REQUEST_TOOLS',
    'NEXTCLOUD_CALENDAR_TOOLS',
    'NEXTCLOUD_CONTACTS_TOOLS',
    'NEXTCLOUD_DECK_TOOLS',
    'NEXTCLOUD_NOTIFICATIONS_TOOLS',
    'NEXTCLOUD_TALK_TOOLS',
    'NEXTCLOUD_TASKS_TOOLS',
    'NEXTCLOUD_NOTES_TOOLS',
    'NEXTCLOUD_MAIL_TOOLS',
    'NEXTCLOUD_ACTIVITY_TOOLS',
    'NEXTCLOUD_TABLES_TOOLS',
    'NEXTCLOUD_FORMS_TOOLS',
    'NEXTCLOUD_TEAMS_TOOLS',
    'NEXTCLOUD_STATUS_TOOLS',
    'WEBPAGE_AUTOMATION_TOOLS',
]);

/** The feature-side entries of integrationTools' GROUP_DEPS, in this order. */
const GROUP_DEP_KEYS = Object.freeze([
    'buildN8nTools', 'N8N_WORKFLOW_TOOLS', 'getN8nToolPermission',
    'webSearchAvailability',
    'officeFileDelivery',
    'memoryTools',
    'automationEvolutionTools',
    'nextcloudClient',
    'nextcloudCapabilities',
    // Licence check of the sanctions tools (feature sanctions_screening), asked only once the org switch is on.
    'sanctionsAccess',
]);

/** @typedef {unknown[] | (() => unknown[])} ToolsetSource  an array, or a getter called when TOOLSETS is first read */

/** @type {Map<string, ToolsetSource>} */
const toolsets = new Map();
/** @type {Map<string, unknown>} */
const groupDeps = new Map();
/** @type {{ TOOLSETS: Record<string, unknown[]>, GROUP_DEPS: Record<string, unknown> } | null} */
let built = null;

/**
 * Register one toolset under its key (a key of TOOLSET_KEYS).
 * @param {string} key
 * @param {ToolsetSource} getterOrArray
 */
function registerToolset(key, getterOrArray) {
    if (!TOOLSET_KEYS.includes(key)) throw new Error(`registerToolset: "${key}" is not a key of TOOLSET_KEYS (integrations/coreToolsets.js)`);
    if (!Array.isArray(getterOrArray) && typeof getterOrArray !== 'function') throw new TypeError(`registerToolset(${key}): an array or a getter`);
    toolsets.set(key, getterOrArray);
    built = null;
}

/** @param {Record<string, ToolsetSource>} map */
function registerToolsets(map) {
    for (const [key, source] of Object.entries(map)) registerToolset(key, source);
}

/**
 * Register GROUP_DEPS entries as they stand in the map: a value, or a lazy getter that stays a getter.
 * @param {Record<string, unknown>} map
 */
function registerGroupDeps(map) {
    for (const [key, value] of Object.entries(map)) {
        if (!GROUP_DEP_KEYS.includes(key)) throw new Error(`registerGroupDeps: "${key}" is not a key of GROUP_DEP_KEYS (integrations/coreToolsets.js)`);
        groupDeps.set(key, value);
    }
    built = null;
}

/** @returns {NonNullable<typeof built>} */
function build() {
    if (built) return built;
    /** @type {Record<string, unknown[]>} */
    const TOOLSETS = {};
    for (const key of TOOLSET_KEYS) {
        const source = toolsets.get(key);
        if (source !== undefined) TOOLSETS[key] = typeof source === 'function' ? source() : source;
    }
    /** @type {Record<string, unknown>} */
    const GROUP_DEPS = {};
    for (const key of GROUP_DEP_KEYS) if (groupDeps.has(key)) GROUP_DEPS[key] = groupDeps.get(key);
    built = { TOOLSETS, GROUP_DEPS };
    return built;
}

registerToolsets({
    AGENT_SEARCH_TOOLS,
    BROWSE_WEB_TOOLS,
    REGEX_GENERATOR_TOOLS,
    KB_SEARCH_TOOLS,
    KB_INGEST_TOOLS,
});

registerGroupDeps({
    webSearchAvailability: () => require('./webSearchAvailability'),
    officeFileDelivery: () => require('./officeFileDelivery'),
    memoryTools: () => require('./memoryTools'),
});

module.exports = {
    /** @returns {Record<string, unknown[]>} */
    get TOOLSETS() { return build().TOOLSETS; },
    /** @returns {Record<string, unknown>} */
    get GROUP_DEPS() { return build().GROUP_DEPS; },
    TOOLSET_KEYS,
    GROUP_DEP_KEYS,
    registerToolset,
    registerToolsets,
    registerGroupDeps,
};

require('../modules/firstParty/registrationChannels').openChannel('integrations/coreToolsets');
