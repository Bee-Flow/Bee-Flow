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
    const userEnabledApps = parseList(await configStore.getConfig(`enabled_apps_user_${userId}`).catch(() => null));
    const orgEnabledIntegrations = await resolveOrgIntegrations(organizationId);
    const merged = mergeEnabled(userEnabledApps, orgEnabledIntegrations);
    const forced = (Array.isArray(include) ? include : []).filter((id) => typeof id === 'string' && id);
    return forced.length ? [...new Set([...merged, ...forced])] : merged;
}

module.exports = {
    mergeEnabled,
    resolveEnabledIntegrations,
    resolveOrgIntegrations,
    _parseList: parseList,
};
