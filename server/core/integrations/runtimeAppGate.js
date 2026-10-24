// @typecheck
'use strict';

/**
 * The runtime app gate of getIntegrationTools: resolves the user's Simple
 * Mode, enabled-apps preference, org allow-list, org-admin active subset,
 * per-group NC opt-out and the unified entitlement snapshot, and folds them
 * into one `isAppOn(appId)`. Split out of integrationTools.js; the body is
 * moved verbatim and runs the same lookups in the same order.
 *
 * The design-time twin (no credentials, no Simple Mode for non-webpage apps)
 * is userAppGate.js.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

const { ORG_EXEMPT_APPS, AUTO_ENABLED_APPS } = require('./integrationAppPolicy');
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');

function createRuntimeAppGate({ configStore, resolveOrgAllowList, resolveOrgActiveSet, lazy }) {
    /**
     * @returns {Promise<{ userSimpleMode: boolean, userOrgId: string|null,
     *   resolvedUserGroupIds: string[], entSnapshot: Object|null,
     *   effectiveIntegrations: Set<string>|null, isAppOn: (appId: string) => boolean }>}
     */
    async function resolveRuntimeAppGate({ userId, session, isAdmin, extraEnabledApps = null, enabledAppsOverride = null }) {
        const extraAppSet = new Set(Array.isArray(extraEnabledApps) ? extraEnabledApps : []);

        // Simple Mode strips the agent's toolbelt to the basics. Notebooks,
        // webpages, meeting transcripts (Fireflies), automations (n8n) and the
        // admin regex-guardrail tools are all withheld so the agent can't act on
        // surfaces the user has explicitly opted out of.
        const userSimpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

        // The user's enabled apps (null = all enabled), unless the caller brought a
        // narrower list of its own for this run.
        const userEnabledApps = Array.isArray(enabledAppsOverride)
            ? enabledAppsOverride
            : await configStore.getConfig(`enabled_apps_user_${userId}`);

        // Load org-level enabled integrations
        let orgEnabledIntegrations = null;
        // Org-admin "active" subset of the super-admin allow-list (non-NC only).
        // null = no restriction (used for NC which has its own group path); a
        // Set = only IDs in here pass the org-admin gate.
        let orgActiveSet = null;
        let userOrgId = null;
        // The user's group ids, hoisted to function scope so gates below the
        // org-resolution block (e.g. the webpages access fallback) can reuse them
        // without a second getUser round-trip.
        let resolvedUserGroupIds = [];
        // Per-group NC opt-out (Fase G). Resolved per-user: only the groups the
        // current user belongs to are loaded, with their disabled_integrations
        // arrays. Used by isAppOn() with "enable wins" semantics — see below.
        let userGroupDisableLists = null;
        // NC ID set — used to skip the org-admin active filter for NC tools,
        // which are governed by the dedicated NC panel + per-group opt-out path.
        let ncIdSet = new Set();
        try {
            const cat = require('./ncIntegrationCatalog');
            ncIdSet = cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []);
        } catch (_) { fallback('core/integrations/runtimeAppGate:resolveRuntimeAppGate', _); /* integration catalog unavailable, no Nextcloud ids to gate */ }
        try {
            const userStore = lazy.userStore();
            const currentUser = await userStore.getUser(userId);
            const isSuperAdmin = isAdmin || session?.user?.role === 'admin';
            if (currentUser?.organizationId) {
                userOrgId = currentUser.organizationId;
                const org = await userStore.getOrganization(currentUser.organizationId);
                // Org override, else the global default; null = all enabled.
                orgEnabledIntegrations = await resolveOrgAllowList(org);
                // Org-admin's active subset. Super admin bypasses this entirely
                // so they can always see/use everything the platform allows.
                orgActiveSet = await resolveOrgActiveSet(currentUser.organizationId, { bypass: isSuperAdmin });
                // Collect disabled_integrations arrays from each group the user
                // belongs to. Skip when user is not in any groups; isAppOn then
                // bypasses the group-deny path entirely.
                const userGroupIds = Array.isArray(currentUser.groups)
                    ? currentUser.groups
                    : (() => { try { return JSON.parse(currentUser.groups || '[]'); } catch { return []; } })();
                resolvedUserGroupIds = userGroupIds;
                if (userGroupIds.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    const groupById = new Map(allGroups.map(g => [g.id, g]));
                    userGroupDisableLists = userGroupIds
                        .map(gid => groupById.get(gid))
                        .filter(Boolean)
                        .map(g => Array.isArray(g.disabled_integrations) ? g.disabled_integrations : []);
                    // If every group's list is empty there's no constraint — drop
                    // the array so isAppOn can short-circuit.
                    if (userGroupDisableLists.every(lst => lst.length === 0)) userGroupDisableLists = null;
                }
            } else if (isSuperAdmin) {
                // Super admins without an org use the '__system__' config scope
                userOrgId = '__system__';
            }
        } catch (e) { log.debug('ignore', e); }

        // AUTO_ENABLED_APPS is module-scoped (integrationAppPolicy.js).

        // Unified entitlement resolution — the single source of truth for which
        // integrations this user/org is entitled to: ceiling ∩ org-grant ∩ per-group
        // grant. This is what folds the org-admin "active" subset AND the new
        // grant-only per-group access into one decision. The per-user `enabled_apps`
        // selection and the legacy NC per-group opt-out stay below as the final
        // tool-selection step — the NC connector path is untouched.
        let entSnapshot = null;
        let effectiveIntegrations = null;
        try {
            const entitlements = lazy.entitlements();
            const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
            const snap = await entitlements.resolveEntitlements({ userId, orgId: resolveOrgId, session });
            entSnapshot = snap;
            if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
        } catch (_) { effectiveIntegrations = null; /* fall back to the legacy org gate */ }
        let _capReg = null;
        try { _capReg = lazy.capabilityRegistry(); } catch (_) { _capReg = null; }
        const isKnownIntegration = (appId) => !!(_capReg && _capReg.getCapability(appId)?.kind === 'integration');

        const isAppOn = (appId) => {
            // Must be enabled at user level (a per-user UX preference).
            // extraAppSet (skill-scoped enablement) bypasses ONLY this preference:
            // an active skill may surface an app the user hasn't toggled on, but
            // the entitlement and credential gates below stay authoritative.
            if (userEnabledApps && !extraAppSet.has(appId)) {
                // For auto-enabled apps, they're on unless _explicitly_ in a list that excluded them
                // after they existed. Since we can't tell, we default to enabled.
                if (AUTO_ENABLED_APPS.includes(appId)) {
                    // Only block if user explicitly has this app in their list AND it's set to off
                    // For now, auto-enabled apps are always on at user level
                } else if (!userEnabledApps.includes(appId)) {
                    return false;
                }
            }
            // ENTITLEMENT — the unified resolver decides org-wide + per-group grants
            // (org_enabled_integrations is the org-wide grant; NC + exempt apps are
            // granted by the resolver's bypass; group grants add within the ceiling).
            // Ids unknown to the registry (exempt infra tools) pass through. If the
            // resolver was unavailable, fall back to the legacy inline org gate so a
            // transient failure never strips an agent's whole toolbelt.
            if (effectiveIntegrations && isKnownIntegration(appId)) {
                if (!effectiveIntegrations.has(appId)) return false;
            } else {
                if (!ORG_EXEMPT_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) return false;
                if (orgActiveSet && !ORG_EXEMPT_APPS.includes(appId) && !ncIdSet.has(appId) && !orgActiveSet.has(appId)) {
                    return false;
                }
            }
            // Per-group NC opt-out with "enable wins" (transitional, NC only). The
            // tool is denied only if EVERY user group disables it — a single
            // permissive group is enough to allow it. Untouched from before.
            if (userGroupDisableLists && appId.startsWith('nextcloud') && userGroupDisableLists.every(lst => lst.includes(appId))) {
                return false;
            }
            return true;
        };

        return { userSimpleMode, userOrgId, resolvedUserGroupIds, entSnapshot, effectiveIntegrations, isAppOn };
    }

    return resolveRuntimeAppGate;
}

module.exports = { createRuntimeAppGate };
