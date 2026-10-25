// @typecheck
/**
 * Which integrations a headless session should load PROVIDER TOKENS for.
 *
 * Every acts-as-someone-else path (a scheduled automation, the webpage bridge, an
 * App Studio connector) has to answer the same question before it can call
 * automationAuth.buildUserAuth: *which* integrations does this user have, so we
 * know whether to fetch Google / Microsoft / Nextcloud credentials from the
 * vault? Three copies of that logic existed and they had drifted — which is how
 * a connector came to tell someone to connect Gmail while Gmail was connected.
 *
 * ── THE TRAP THIS MODULE EXISTS TO CLOSE ────────────────────────────
 * An org's live integration grants live in `org_enabled_integrations` (surfaced
 * as `org.orgEnabledIntegrations`). The older `organizations."enabledIntegrations"`
 * column is only populated for orgs a super-admin explicitly overrode. Reading
 * ONLY the legacy column therefore yields an empty list for most orgs — and an
 * empty list is not harmless:
 *
 *   buildUserAuth(userId, { enabledIntegrations: [] })
 *     → providersForIntegrations([]) is []
 *     → the `required.length === 0` early return hands back a TRUTHY object
 *       whose accessToken is null (auth/automationAuth.js)
 *     → a caller guarding with `if (built)` adopts a token-less session
 *     → the Google client throws "Not connected to Gmail" for a connected user.
 *
 * So: union both columns, fall back to the global default, and treat a missing
 * list as "all" rather than "none" (the convention core/integrationTools.js
 * already uses — `null` there means no user-level restriction).
 *
 * This list only decides WHICH PROVIDER TOKENS TO LOAD. It is not an
 * authorization gate: per-tool access is still enforced downstream by
 * getIntegrationTools/isAppOn, which re-checks org, group and personal grants.
 * Widening it can therefore never grant a tool the user may not use.
 */

'use strict';

const configStore = require('../../stores/configStore');
const userStore = require('../../stores/userStore');
const { fallback } = require('../../utils/bestEffort');

/**
 * Intersect a user-level list with an org-level one. A missing list on either
 * side means "no restriction from that side", NOT "nothing" — a user who never
 * opened the app-toggles panel has no saved list at all.
 */
function mergeEnabled(userList, orgList) {
    if (!Array.isArray(userList) && !Array.isArray(orgList)) return [];
    if (!Array.isArray(userList)) return [...orgList];
    if (!Array.isArray(orgList)) return [...userList];
    return userList.filter((id) => orgList.includes(id));
}

/**
 * @param {string} value
 */
function parseList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    }
    return null;
}

/**
 * The org's integration grants: the current column UNIONED with the legacy one,
 * falling back to the deployment-wide default when the org declares neither.
 * @param {string | null} organizationId
 */
async function resolveOrgIntegrations(organizationId) {
    if (!organizationId) return null;
    try {
        const org = await userStore.getOrganization(organizationId);
        const lists = [];
        const current = parseList(org?.orgEnabledIntegrations);
        if (current) lists.push(...current);
        const legacy = parseList(org?.enabledIntegrations);
        if (legacy) lists.push(...legacy);
        if (lists.length) return [...new Set(lists)];

        const globalDefaults = parseList(await configStore.getConfig('default_org_integrations'));
        return globalDefaults;
    } catch {
        // A lookup failure must not silently narrow the list to nothing — that
        // is the exact shape of the bug this module exists to prevent.
        return null;
    }
}

/**
 * The integration ids a headless session for `userId` should load tokens for.
 *
 * @param {string} userId
 * @param {string|null} organizationId
 * @param {object} [opts]
 * @param {string[]} [opts.include]  Integration ids to force into the result —
 *        pass the integration you are ABOUT TO DISPATCH. Config can then never
 *        leave the list empty for the one call that needs it, which is what
 *        triggerBus and supportAiResponder already do by other means.
 * @returns {Promise<string[]>}
 */
async function resolveEnabledIntegrations(userId, organizationId, { include = [] } = {}) {
    const userEnabledApps = parseList(await configStore.getConfig(`enabled_apps_user_${userId}`).catch((e) => fallback('core/integrations/enabledIntegrations:resolveEnabledIntegrations', e, null)));
    const orgEnabledIntegrations = await resolveOrgIntegrations(organizationId);
    const merged = mergeEnabled(userEnabledApps, orgEnabledIntegrations);
    const forced = (Array.isArray(include) ? include : []).filter((id) => typeof id === 'string' && id);
    return forced.length ? [...new Set([...merged, ...forced])] : merged;
}

// ── The org allow-list as the request paths read it ──────────────────
//
// Before this helper the "super-admin allow-list, else the global default"
// read lived inline in eight places with three different readings. They are
// kept apart on purpose (each caller passes the options that reproduce what it
// did before); unifying them would change what users see.
//
//   overrideWhen 'truthy'  — `organizations."enabledIntegrations"` overrides when
//                            it is truthy ('' falls through to the default).
//                            Runtime gates, /auth/me, the wizard, the n8n check.
//   overrideWhen 'present' — it overrides whenever it is not null/undefined.
//                            The org-admin Integration access screens.
//   parse 'strict'         — a string is JSON.parse'd (a bad string THROWS, the
//                            caller's own catch decides), anything else as is.
//   parse 'lenient'        — an array as is, a string that parses to an array,
//                            anything else [] (featureAccessRoutes).
//   whenUnset              — the answer when neither the org nor the global
//                            default says anything: null ("all enabled") or a
//                            caller-supplied list.
//
// configStore/userStore are required lazily so a test that swaps them in
// require.cache after this module loaded still reaches its stub.

/**
 * @param {string} value
 */
function parseStrict(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * @param {string} raw
 */
function parseLenient(raw) {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}

/**
 * @param {Record<string, any>|null|undefined} org  an organizations row (getOrganization)
 * @param {object} [opts]
 * @param {'truthy'|'present'} [opts.overrideWhen='truthy']
 * @param {'strict'|'lenient'} [opts.parse='strict']
 * @param {string[]|null} [opts.whenUnset=null]
 * @returns {Promise<{ list: any, source: 'org_override'|'global_default'|'all_enabled' }>}
 */
async function resolveOrgAllowListWithSource(org, { overrideWhen = 'truthy', parse = 'strict', whenUnset = null } = {}) {
    const parseFn = parse === 'lenient' ? parseLenient : parseStrict;
    const raw = org?.enabledIntegrations;
    const overrides = overrideWhen === 'present' ? (raw !== null && raw !== undefined) : !!raw;
    if (overrides) return { list: parseFn(raw), source: 'org_override' };
    const store = require('../../stores/configStore');
    const globalDefaults = await store.getConfig('default_org_integrations');
    if (globalDefaults) return { list: parseFn(globalDefaults), source: 'global_default' };
    return { list: whenUnset, source: 'all_enabled' };
}

/**
 * The org's super-admin allow-list; see resolveOrgAllowListWithSource for opts.
 * @param {Readonly<{ overrideWhen: 'present'; parse: 'lenient'; readonly whenUnset: string[]; }>} [opts]
 */
async function resolveOrgAllowList(org, opts) {
    return (await resolveOrgAllowListWithSource(org, opts)).list;
}

/**
 * The org-admin "active integrations" subset as a Set, or null when it does not
 * apply: for a super admin (`bypass`) and for design-time palettes
 * (`forPalette`), which deliberately ignore it. A store failure yields an EMPTY
 * set, which is what the runtime gates did inline.
 */
async function resolveOrgActiveSet(orgId, { forPalette = false, bypass = false } = {}) {
    if (forPalette || bypass) return null;
    try {
        const store = require('../../stores/userStore');
        const activeList = await store.getOrgEnabledIntegrations(orgId);
        return new Set(activeList);
    } catch (_) { return new Set(); }
}

module.exports = {
    mergeEnabled,
    resolveOrgAllowList,
    resolveOrgAllowListWithSource,
    resolveOrgActiveSet,
    resolveEnabledIntegrations,
    resolveOrgIntegrations,
    _parseList: parseList,
};
