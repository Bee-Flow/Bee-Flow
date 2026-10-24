'use strict';

/**
 * The design-time per-user app gate (automation builder palette, automation
 * save/activate validation, App Studio steps). Split out of
 * integrationTools.js; moved verbatim. The runtime twin is runtimeAppGate.js.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

const { featureModule } = require('../featureModules');
const { ORG_EXEMPT_APPS, AUTO_ENABLED_APPS } = require('./integrationAppPolicy');
const log = require('../../telemetry/log');

function createUserAppGate({ configStore, resolveOrgAllowList, webpageToolsAllowed, lazy }) {
    /**
     * Same permission gates as `isAppOn` inside `getIntegrationTools`, exposed
     * as a standalone helper for callers that want to know "what apps is this
     * user *allowed* to use" — distinct from "what apps are wired up with
     * credentials right now".
     *
     * Used by the automation builder's catalog: the palette shows every
     * permitted app (with a "Connect" badge when credentials are missing) so
     * users can drop the node first and authenticate after. Without this the
     * palette was credential-gated and looked empty on dev instances where
     * OAuth hadn't been completed yet.
     */
    /**
     * Build the per-user integration gate: `isAppOn(appId) → boolean`, applying the
     * per-user allow-list, the entitlement snapshot, the org grant and the group
     * disable-lists in that order.
     *
     * Split out of getUserPermittedApps so a caller can ask about ONE app without
     * going through TOOL_REGISTRY. That intersection is right for a palette — you
     * cannot offer a tool that has no tools — but it silently answers "no" for every
     * integration that isn't a TOOLS-array module. `browser-fetch` is exactly that:
     * browse_web is registered inline (see the docker-probe branch in integrationTools.js), never via
     * the registry, so getUserPermittedApps can never return it for anyone. An
     * App Studio ai_browse step gated on `permitted.has('browser-fetch')` was
     * therefore refused on every deployment, for every user, whatever the org had
     * granted — and the unit test could not see it, because it stubbed this function
     * to return a value it is structurally incapable of returning.
     *
     * `onlyAppId`: the caller will ask about that one app only, so the beta and
     * webpage-access lookups that only `webpages` needs are skipped unless that
     * app is `webpages` (a gate built for another app answers no for it).
     */
    async function buildUserAppGate({ userId, session, isAdmin, onlyAppId = null } = {}) {
        // A config-lookup failure here must not propagate: the caller
        // (automationBuilder.js's catalog builder) treats a thrown exception as
        // "couldn't resolve permissions" and falls back to permit-ALL apps —
        // exactly the fail-open behavior this function exists to prevent. Fail
        // open at just this one narrow layer instead (same posture as the other
        // catches in this function below): skip the per-user allowlist check,
        // fall through to the org/group gates, which still apply normally.
        let userEnabledApps = null;
        try { userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`); }
        catch (err) { log.debug('fail open at this layer only — org/group gates below still enforce', err); }
        let orgEnabledIntegrations = null;
        let userGroupDisableLists = null;
        // ENTITLEMENT — the same unified resolver getIntegrationTools() gates on.
        // Without it this helper answered from `organizations.enabledIntegrations`
        // alone, which is the SUPER-admin allow-list; the org-admin's own
        // distribution (org_enabled_integrations, written by the Integration
        // access screen) never reached it. An org whose legacy column was seeded
        // narrow at creation therefore had a palette and an automation validator that
        // contradicted the screen the admin was looking at — the builder offered
        // agent_search, and saving the automation rejected it as "not in user's
        // catalog". Same fallback posture as getIntegrationTools: a resolver
        // failure drops back to the legacy inline gate rather than stripping
        // everything.
        let effectiveIntegrations = null;
        let isKnownIntegration = () => false;
        try {
            const entitlements = lazy.entitlements();
            const snap = await entitlements.resolveEntitlements({ userId, session });
            if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
            const capReg = lazy.capabilityRegistry();
            isKnownIntegration = (appId) => capReg.getCapability(appId)?.kind === 'integration';
        } catch (_) { effectiveIntegrations = null; /* fall back to the legacy org gate */ }
        try {
            const cat = require('./ncIntegrationCatalog');
            // ncIdSet was used only by the orgActiveSet gate (now dropped); kept require
            // for parity with getIntegrationTools and to surface load errors fast.
            void (cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []));
        } catch (_) { log.warn('integration catalog failed to load', _); }
        // Inputs for the webpages rule, resolved the way getIntegrationTools does.
        let webpageGroupIds = [];
        let webpageOrgId = null;
        try {
            const userStore = lazy.userStore();
            const currentUser = await userStore.getUser(userId);
            if (currentUser?.organizationId) webpageOrgId = currentUser.organizationId;
            else if (isAdmin || session?.user?.role === 'admin') webpageOrgId = '__system__';
            if (currentUser?.organizationId) {
                const org = await userStore.getOrganization(currentUser.organizationId);
                orgEnabledIntegrations = await resolveOrgAllowList(org);
                // NOTE: orgActiveSet (the org-admin "active integrations" subset) is
                // intentionally NOT consulted here. That layer is a runtime override
                // for tool dispatch: when an org has not populated it (the default
                // on most installs incl. dev) it ends up as an empty Set, which
                // erroneously hides EVERY non-NC, non-exempt app. The palette is design-
                // time discovery; runtime still enforces all gates via
                // getIntegrationTools. See plan: kijk-naar-het-ontwerp-sequential-wirth.
                const userGroupIds = Array.isArray(currentUser.groups)
                    ? currentUser.groups
                    : (() => { try { return JSON.parse(currentUser.groups || '[]'); } catch { return []; } })();
                webpageGroupIds = userGroupIds;
                if (userGroupIds.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    const groupById = new Map(allGroups.map(g => [g.id, g]));
                    userGroupDisableLists = userGroupIds
                        .map(gid => groupById.get(gid))
                        .filter(Boolean)
                        .map(g => Array.isArray(g.disabled_integrations) ? g.disabled_integrations : []);
                    if (userGroupDisableLists.every(lst => lst.length === 0)) userGroupDisableLists = null;
                }
            }
        } catch (err) { log.debug('fail open', err); }

        // `webpages` is a beta capability, not an org integration: no org
        // allow-list can name it, so judging it by one refused webpage steps the
        // runtime would run. It gets the runtime's own rule instead, resolved now
        // because isAppOn is synchronous. The helper never throws. A caller that
        // asks about ONE other app (isIntegrationPermittedForUser) never reads
        // this answer, so it does not pay for the beta and access lookups.
        let webpagesOn = false;
        if (!onlyAppId || onlyAppId === 'webpages') {
            let userSimpleMode = true;
            try { userSimpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`)); }
            catch (err) { log.debug('unknown → withhold webpages (fail closed), like a failed beta lookup', err); }
            webpagesOn = await webpageToolsAllowed({
                userId, session, groupIds: webpageGroupIds, orgId: webpageOrgId, simpleMode: userSimpleMode,
            });
        }

        const isAppOn = (appId) => {
            if (userEnabledApps) {
                if (AUTO_ENABLED_APPS.includes(appId)) {
                    // auto-enabled — bypass user list
                } else if (!userEnabledApps.includes(appId)) {
                    return false;
                }
            }
            if (appId === 'webpages') return webpagesOn;
            if (effectiveIntegrations && isKnownIntegration(appId)) {
                if (!effectiveIntegrations.has(appId)) return false;
            } else if (!ORG_EXEMPT_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) {
                return false;
            }
            // orgActiveSet check intentionally omitted — see comment above where it's resolved.
            if (userGroupDisableLists && appId.startsWith('nextcloud') && userGroupDisableLists.every(lst => lst.includes(appId))) {
                return false;
            }
            return true;
        };

        return isAppOn;
    }

    /**
     * The apps a user may be OFFERED in a palette / catalog.
     *
     * Intersected with TOOL_REGISTRY on purpose: this answers "what can I put on a
     * canvas", and an app with no tools array has nothing to put there. Do NOT use
     * it to authorise one specific integration — see isIntegrationPermittedForUser.
     */
    async function getUserPermittedApps({ userId, session, isAdmin } = {}) {
        if (!userId) return new Set();
        const isAppOn = await buildUserAppGate({ userId, session, isAdmin });
        const out = new Set();
        try {
            const { TOOL_REGISTRY } = featureModule('automation/toolRegistry');
            for (const entry of TOOL_REGISTRY) {
                if (isAppOn(entry.app)) out.add(entry.app);
            }
        } catch (err) { log.debug('registry unavailable', err); }
        return out;
    }

    /**
     * Is ONE integration permitted for this user? Same gate chain as
     * getUserPermittedApps, without the TOOL_REGISTRY intersection — so it answers
     * correctly for inline-registered integrations (browser-fetch, workspace) that
     * a palette has no reason to list.
     *
     * This is the authorisation question. getUserPermittedApps is the discovery one.
     */
    async function isIntegrationPermittedForUser({ userId, appId, session, isAdmin } = {}) {
        if (!userId || !appId) return false;
        const isAppOn = await buildUserAppGate({ userId, session, isAdmin, onlyAppId: appId });
        return isAppOn(appId);
    }

    return { buildUserAppGate, getUserPermittedApps, isIntegrationPermittedForUser };
}

module.exports = { createUserAppGate };
