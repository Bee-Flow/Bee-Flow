'use strict';

/**
 * Integration app policy: the app-id lists and the webpages rule that BOTH the
 * runtime tool resolution (integrationTools.getIntegrationTools via
 * runtimeAppGate.js) and the design-time gate (userAppGate.js) read, so the
 * two can never disagree. Split out of integrationTools.js; moved verbatim.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

// IDs that are exempt from org-level gating (admin-only tools, internal utilities)
// 'memory' (2026-09-04): first-party, per-user data that never leaves the
// instance — gated by the memory feature itself, not by an org integration grant.
const ORG_EXEMPT_APPS = ['workspace', 'regex-gen', 'kb-ingest', 'memory', 'automation-evolution'];

// Integrations auto-enabled for users with an existing saved enabled-apps list
// (they were added after the user saved their list, so they wouldn't be in it).
// Module-scoped because BOTH getIntegrationTools() and getUserPermittedApps()
// gate on it — when this lived inside getIntegrationTools the permitted-apps
// helper threw a ReferenceError that was swallowed, emptying the builder palette.
// The Nextcloud entries must stay in step with ncIntegrationCatalog — this
// copy had drifted, missing tables/forms/teams, so those three sat behind a
// per-user toggle nobody could see. Kept as a plain literal (rather than a
// spread of the catalog) because two suites read this list out of the source
// text; ncCatalogDrift.test.js is what now fails the build if it drifts again.
const AUTO_ENABLED_APPS = ['agent-search', 'browser-fetch', 'workspace', 'image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'google-maps', 'linkedin', 'github', 'google-contacts', 'google-keep', 'outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts', 'google-groups', 'n8n', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck', 'nextcloud-mail', 'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-activity', 'nextcloud-tables', 'nextcloud-forms', 'nextcloud-teams', 'nextcloud-status', 'webpages', 'memory', 'automation-evolution'];

function createWebpageToolsAllowed({ userHasBetaFeature, lazy }) {
    /**
     * May this user receive the webpage automation tools (webpages_*, webpage_db_*)?
     *
     * ONE rule, read by both the runtime (getIntegrationTools) and the design-time
     * gate (buildUserAppGate → automation save/activate validation, the AI builder):
     * never in Simple Mode; otherwise the `webpages` beta feature, or — failing
     * that — actually having a webpage to act on (owning one, or one org/group-
     * shared to the user). `webpages` is a beta capability, not an org integration,
     * so it can never appear in an org integration allow-list; when the design-
     * time gate judged it by that list instead, an automation the runtime would happily
     * run was refused as "not in user's catalog".
     *
     * Never throws: a failed lookup answers false (fail closed).
     */
    async function webpageToolsAllowed({ userId, session = null, groupIds = [], orgId = null, simpleMode = false } = {}) {
        if (!userId || simpleMode) return false;
        let ok = false;
        try {
            // The beta feature is the real gate for the whole Webpages capability:
            // it unlocks the Studio app, the direct webpage chat and the automations
            // catalog (routes/automation/catalog.js) alike.
            ok = await userHasBetaFeature(userId, 'webpages', session);
        } catch (_) { return false; /* beta lookup failed — fail closed */ }
        if (ok) return true;
        // Fallback: a user who actually has a webpage they can act on can edit
        // that page even without the beta toggle — otherwise a legitimate webpage
        // owner hit "You no longer have permission to use webpages_list" when a
        // automation step ran. NOT fail-open: dispatch re-checks canWriteWebpage per
        // call (toolDispatcher → isWebpageAutomationTool), so the tools only act
        // on pages the caller genuinely has access to.
        try {
            const webpageStore = lazy.webpageStore();
            return !!(await webpageStore.userHasAnyWebpageAccess(userId, Array.isArray(groupIds) ? groupIds : [], orgId ? [orgId] : []));
        } catch (_) { return false; /* access probe failed — stay with the beta result */ }
    }

    return webpageToolsAllowed;
}

module.exports = { ORG_EXEMPT_APPS, AUTO_ENABLED_APPS, createWebpageToolsAllowed };
