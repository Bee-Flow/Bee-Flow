/**
 * Integration Tools — Shared tool injection for direct chat and agent chat
 * 
 * Builds the list of available integration tools (Gmail, Calendar,
 * Docs, Drive, Fireflies, YouTrack, Gamma, N8N, Tavily, Image Gen,
 * Video Gen, Terminal, Regex Generator) based on user session,
 * org settings, and enabled apps.
 */

const configStore = require('../../stores/configStore');
const { GMAIL_TOOLS } = require('../../integrations/gmailTools');
const { CALENDAR_TOOLS } = require('../../integrations/calendarTools');
const { DRIVE_TOOLS } = require('../../integrations/driveTools');
const { DOCS_TOOLS } = require('../../integrations/docsTools');
const { SHEETS_TOOLS } = require('../../integrations/sheetsTools');
const { SLIDES_TOOLS } = require('../../integrations/slidesTools');
const { CONTACTS_TOOLS } = require('../../integrations/contactsTools');
const { KEEP_TOOLS } = require('../../integrations/keepTools');
const { GOOGLE_GROUPS_TOOLS } = require('../../integrations/googleGroupsTools');
const { FIREFLIES_TOOLS } = require('../../integrations/firefliesTools');
const { YOUTRACK_TOOLS } = require('../../integrations/youtrackTools');
const { SIGNREQUEST_TOOLS } = require('../../integrations/signrequestTools');
const { GAMMA_TOOLS } = require('../../integrations/gammaTools');
const { AFAS_TOOLS } = require('../../integrations/afasTools');
const { NMBRS_TOOLS } = require('../../integrations/nmbrsTools');
const { VPLAN_TOOLS } = require('../../integrations/vplanTools');
const { SCALEWAY_BILLING_TOOLS } = require('../../integrations/scalewayBillingTools');
const { buildN8nTools } = require('../../integrations/n8nTools');
const { N8N_WORKFLOW_TOOLS, getN8nToolPermission } = require('../../integrations/n8nWorkflowTools');
const { hasPermission } = require('../../auth/permissions');
const { AGENT_SEARCH_TOOLS } = require('../../integrations/agentSearchTools');
const { BROWSE_WEB_TOOLS } = require('../../integrations/browserFetchTools');
const { REGEX_GENERATOR_TOOLS } = require('../../integrations/regexGeneratorTools');
const { IMAGE_GEN_TOOLS } = require('../tools/imageGenTool');
const { VIDEO_GEN_TOOLS } = require('../tools/videoGenTool');
const { ELEVENLABS_TOOLS } = require('../tools/elevenLabsTools');
const { WORKSPACE_TOOLS } = require('../../integrations/workspaceTools');
const { KB_SEARCH_TOOLS } = require('../../integrations/kbSearchTools');
const { KB_INGEST_TOOLS } = require('../../integrations/kbIngestTools');
const { MAPS_TOOLS } = require('../../integrations/mapsTools');
const { LINKEDIN_TOOLS } = require('../../integrations/linkedinTools');
const { WITHINGS_TOOLS } = require('../../integrations/withingsTools');
const { GITHUB_TOOLS } = require('../../integrations/githubTools');
const { OUTLOOK_TOOLS, OUTLOOK_READONLY_TOOLS } = require('../../integrations/outlookTools');
const { MS_CALENDAR_TOOLS } = require('../../integrations/msCalendarTools');
const { ONEDRIVE_TOOLS } = require('../../integrations/oneDriveTools');
const { MS_CONTACTS_TOOLS } = require('../../integrations/msContactsTools');
const { TRANSCRIPTION_TOOLS } = require('../../integrations/transcriptionTools');
const { NEXTCLOUD_TOOLS } = require('../../integrations/nextcloudTools');
const { NEXTCLOUD_CALENDAR_TOOLS } = require('../../integrations/nextcloudCalendarTools');
const { NEXTCLOUD_CONTACTS_TOOLS } = require('../../integrations/nextcloudContactsTools');
const { NEXTCLOUD_DECK_TOOLS } = require('../../integrations/nextcloudDeckTools');
const { NEXTCLOUD_NOTIFICATIONS_TOOLS } = require('../../integrations/nextcloudNotificationsTools');
const { NEXTCLOUD_TALK_TOOLS } = require('../../integrations/nextcloudTalkTools');
const { NEXTCLOUD_TASKS_TOOLS } = require('../../integrations/nextcloudTasksTools');
const { NEXTCLOUD_NOTES_TOOLS } = require('../../integrations/nextcloudNotesTools');
const { NEXTCLOUD_MAIL_TOOLS } = require('../../integrations/nextcloudMailTools');
const { NEXTCLOUD_ACTIVITY_TOOLS } = require('../../integrations/nextcloudActivityTools');
const { NEXTCLOUD_TABLES_TOOLS } = require('../../integrations/nextcloudTablesTools');
const { NEXTCLOUD_FORMS_TOOLS } = require('../../integrations/nextcloudFormsTools');
const { NEXTCLOUD_TEAMS_TOOLS } = require('../../integrations/nextcloudTeamsTools');
const { NEXTCLOUD_STATUS_TOOLS } = require('../../integrations/nextcloudStatusTools');
const { WEBPAGE_AUTOMATION_TOOLS } = require('../../integrations/webpageAutomationTools');
const { userHasBetaFeature } = require('../entitlements/betaFeatures');
const log = require('../../telemetry/log');

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
        const webpageStore = require('../../stores/webpageStore');
        return !!(await webpageStore.userHasAnyWebpageAccess(userId, Array.isArray(groupIds) ? groupIds : [], orgId ? [orgId] : []));
    } catch (_) { return false; /* access probe failed — stay with the beta result */ }
}

/**
 * Build the list of integration tools available for the current user.
 * 
 * @param {Object} options
 * @param {string}  options.userId       - Current user ID
 * @param {Object}  options.session      - Express session (for OAuth tokens)
 * @param {boolean} options.isAdmin      - Whether user is admin
 * @param {string[]|null} options.enabledAppsOverride - Stands in for the
 *   user's workspace-wide enabled-apps preference for this call. Used by a
 *   cowork item that carries its own, narrower list: the run may only touch
 *   what that item allows, regardless of what the user has on elsewhere.
 *   Goes through the SAME gate as the stored preference, so the
 *   AUTO_ENABLED_APPS carve-out and every entitlement/credential check below
 *   still apply — it narrows the user layer, it can never widen anything.
 * @param {string[]|null} options.extraEnabledApps - App ids allowed by an
 *   active skill (skill-scoped enablement). INVARIANT: this bypasses ONLY the
 *   per-user enabled-apps preference — it must never widen org entitlements
 *   or skip credential/session checks.
 * @returns {Object} { tools: Array, n8nOrgId: string|null }
 */
async function getIntegrationTools({ userId, session, isAdmin, agentConfig, automationStep = false, connectionPolicy = null, extraEnabledApps = null, enabledAppsOverride = null }) {
    const extraAppSet = new Set(Array.isArray(extraEnabledApps) ? extraEnabledApps : []);
    const tools = [];
    let n8nOrgId = null;

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
    } catch (_) { }
    try {
        const userStore = require('../../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        const isSuperAdmin = isAdmin || session?.user?.role === 'admin';
        if (currentUser?.organizationId) {
            userOrgId = currentUser.organizationId;
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                // Org has custom overrides
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations)
                    : org.enabledIntegrations;
            } else {
                // Org uses defaults — load global default integrations
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults)
                        : globalDefaults;
                }
                // null globalDefaults = all enabled (no defaults configured yet)
            }
            // Org-admin's active subset. Super admin bypasses this entirely
            // so they can always see/use everything the platform allows.
            if (!isSuperAdmin) {
                try {
                    const activeList = await userStore.getOrgEnabledIntegrations(currentUser.organizationId);
                    orgActiveSet = new Set(activeList);
                } catch (_) { orgActiveSet = new Set(); }
            }
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
    } catch (e) { /* ignore */ }

    // AUTO_ENABLED_APPS is now module-scoped (see top of file).

    // Unified entitlement resolution — the single source of truth for which
    // integrations this user/org is entitled to: ceiling ∩ org-grant ∩ per-group
    // grant. This is what folds the org-admin "active" subset AND the new
    // grant-only per-group access into one decision. The per-user `enabled_apps`
    // selection and the legacy NC per-group opt-out stay below as the final
    // tool-selection step — the NC connector path is untouched.
    let entSnapshot = null;
    let effectiveIntegrations = null;
    try {
        const entitlements = require('../entitlements/entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        const snap = await entitlements.resolveEntitlements({ userId, orgId: resolveOrgId, session });
        entSnapshot = snap;
        if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
    } catch (_) { effectiveIntegrations = null; /* fall back to the legacy org gate */ }
    let _capReg = null;
    try { _capReg = require('../entitlements/capabilityRegistry'); } catch (_) { _capReg = null; }
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

    // ── Per-action grants (agent-only) ──────────────────────────────
    // `agentConfig.tools` narrows an app the agent already has ON down to
    // named actions. It lives NEXT TO enabledIntegrations, which stays the
    // app-level switch — this only ever SUBTRACTS from what the gates above
    // already allowed, and an agent (or a caller) without a `tools` map keeps
    // exactly today's toolbelt, which is why there is no migration.
    //
    // Applied inside addTools rather than at each call site so it cannot be
    // forgotten on the ~80th `if (isAppOn(x)) addTools(X_TOOLS)` line.
    let _grantsConfig = null;
    let _isToolGranted = null;
    try {
        const _policy = require('../agentRuntime/toolPolicy');
        _grantsConfig = _policy.toolsConfigOf(agentConfig);
        if (_grantsConfig) _isToolGranted = (tool) => _policy.isToolAllowed(tool, _grantsConfig);
    } catch (e) {
        // A policy-module failure must not silently WIDEN the toolbelt, but it
        // also must not empty it: without a `tools` map there is nothing to
        // enforce anyway, and with one the safest reachable state is the
        // pre-grant behaviour plus a loud line in the log.
        log.warn('[IntegrationTools] tool policy unavailable — per-action grants not applied:', e.message);
    }

    const addTools = (toolArray) => {
        for (const tool of toolArray) {
            if (_isToolGranted && !_isToolGranted(tool)) continue;
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    };

    // BFSF-255: password-account users acquire Google tokens via the
    // Settings → Connections tile (encrypted vault), not via SSO login — so a
    // session without ANY OAuth identity gets hydrated from the vault before
    // the provider checks below. Sessions that already carry a provider
    // (Google/Microsoft/Nextcloud SSO) are never touched: the dispatcher hands
    // ONE session to the executors and mixing providers would run Gmail calls
    // with a foreign token.
    // The same now applies to Microsoft: a user who connects Outlook through
    // Settings → Connections has a vault credential but no SSO session. Google
    // is tried first purely to preserve the pre-existing precedence for users
    // who somehow hold both; each helper is a no-op once a provider is set.
    if (!session?.oauthProvider && session?.user?.id) {
        try {
            const { hydrateGoogleSessionFromVault } = require('../../auth/googleSessionHydration');
            await hydrateGoogleSessionFromVault(session);
        } catch (_) { /* non-fatal — tools just stay unavailable */ }
    }
    if (!session?.oauthProvider && session?.user?.id) {
        try {
            const { hydrateMicrosoftSessionFromVault } = require('../../auth/microsoftSessionHydration');
            await hydrateMicrosoftSessionFromVault(session);
        } catch (_) { /* non-fatal — tools just stay unavailable */ }
    }

    // Google integrations — require OAuth
    if (session?.oauthProvider === 'google' && session?.accessToken) {
        if (isAppOn('gmail')) addTools(GMAIL_TOOLS);
        if (isAppOn('google-calendar')) addTools(CALENDAR_TOOLS);
        if (isAppOn('google-drive')) addTools(DRIVE_TOOLS);
        if (isAppOn('google-docs')) addTools(DOCS_TOOLS);
        if (isAppOn('google-sheets')) addTools(SHEETS_TOOLS);
        if (isAppOn('google-slides')) addTools(SLIDES_TOOLS);
        if (isAppOn('google-contacts')) addTools(CONTACTS_TOOLS);
        if (isAppOn('google-keep')) addTools(KEEP_TOOLS);
        if (isAppOn('google-groups')) addTools(GOOGLE_GROUPS_TOOLS);
    }

    // Microsoft integrations — require Microsoft OAuth
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) {
        if (isAppOn('outlook')) addTools(OUTLOOK_TOOLS);
        if (isAppOn('outlook-readonly')) addTools(OUTLOOK_READONLY_TOOLS);
        if (isAppOn('ms-calendar')) addTools(MS_CALENDAR_TOOLS);
        if (isAppOn('onedrive')) addTools(ONEDRIVE_TOOLS);
        if (isAppOn('ms-contacts')) addTools(MS_CONTACTS_TOOLS);
    } else if (userId && (isAppOn('outlook') || isAppOn('outlook-readonly'))) {
        // Multi-provider: a Google (or Nextcloud) session whose user ALSO
        // connected Microsoft 365 through Settings → Connections — or a
        // automation session whose primary provider is not Microsoft but which
        // carries `automationProviders.microsoft`. The session itself stays as it
        // is (the Google tools above need its token); the Outlook tools get a
        // Microsoft-only shim at dispatch (toolDispatcher). Only Outlook is
        // lifted here: its approval routes resolve the same shim, the other
        // Microsoft apps still read the live session.
        let msSession = null;
        try {
            const { resolveMicrosoftSession } = require('../../auth/microsoftSessionHydration');
            msSession = await resolveMicrosoftSession(session, userId);
        } catch (_) { /* non-fatal — Outlook just stays unavailable */ }
        if (msSession?.accessToken) {
            if (isAppOn('outlook')) addTools(OUTLOOK_TOOLS);
            if (isAppOn('outlook-readonly')) addTools(OUTLOOK_READONLY_TOOLS);
        }
    }

    // Image Generation — requires Google API key
    const hasGoogleKey = !!(await configStore.getSecret('google_api_key'));
    if (hasGoogleKey && isAppOn('image-gen')) {
        addTools(IMAGE_GEN_TOOLS);
    }

    // Video Generation — requires Google API key (Veo 3.1)
    if (hasGoogleKey && isAppOn('video-gen')) {
        addTools(VIDEO_GEN_TOOLS);
    }

    // ElevenLabs — Music (with vocals), TTS, Sound Effects
    const hasElevenLabsKey = !!(await configStore.getSecret('elevenlabs_api_key'));
    if (hasElevenLabsKey && isAppOn('elevenlabs')) {
        addTools(ELEVENLABS_TOOLS);
    }

    // Agent Search — self-hosted AI search, Bing, or cloud-only node-search
    const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    const hasSerperKey = !!(await configStore.getSecret('serper_api_key'));
    // When the configured provider is agent-search but the GPU service URL is
    // gone (typical CPU-only deploy), fall back to node-search transparently
    // so the agent keeps having a search tool. The dispatcher mirrors this.
    const canFallbackToNode = searchProvider === 'agent-search' && !hasAgentSearchUrl && hasSerperKey;
    const searchAvailable = searchProvider !== 'disabled' && (
        (searchProvider === 'bing' && hasBingSearchKey) ||
        (searchProvider === 'node-search' && hasSerperKey) ||
        (searchProvider === 'agent-search' && hasAgentSearchUrl) ||
        canFallbackToNode
    );
    if (searchAvailable && isAppOn('agent-search')) {
        addTools(AGENT_SEARCH_TOOLS);
        if (canFallbackToNode) {
            log.warn('[IntegrationTools] agent_search registered via node-search fallback: provider=agent-search but SEARCH_SERVICE_URL/agent_search_url is empty. Using serper_api_key directly. Set search_provider=node-search explicitly to silence this.');
        }
    } else if (isAppOn('agent-search') && searchProvider !== 'disabled') {
        if (searchProvider === 'agent-search') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=agent-search but SEARCH_SERVICE_URL is not set, no agent_search_url admin config, and no serper_api_key for node-search fallback. The model will not have web search. Set SEARCH_SERVICE_URL, or set serper_api_key + search_provider=node-search.');
        } else if (searchProvider === 'bing') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=bing but bing_search_key secret is not set. The model will not have web search.');
        } else if (searchProvider === 'node-search') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=node-search but serper_api_key secret is not set. The model will not have web search.');
        }
    }

    // Browse Web — interactive headless browser (drive/read JS-rendered pages)
    // for content agent_search's plain fetch can't render. Cheap operational
    // probe only (dockerAvailable()/BROWSER_WS_ENDPOINT) — never spins up the
    // bf-browser container here, that happens lazily on first actual tool call.
    if (isAppOn('browser-fetch')) {
        let hasBrowserBackend = false;
        try {
            const pwtRunner = require('../../services/pwtRunner');
            hasBrowserBackend = !!process.env.BROWSER_WS_ENDPOINT || await pwtRunner.dockerAvailable();
        } catch (_) { hasBrowserBackend = false; }
        if (hasBrowserBackend) {
            addTools(BROWSE_WEB_TOOLS);
        } else {
            log.warn('[IntegrationTools] browse_web NOT registered: no browser backend available (Docker unreachable and BROWSER_WS_ENDPOINT unset).');
        }
    }

    // ── Connection lending (gated) ──────────────────────────────────
    // On a SHARED resource run (connectionPolicy carries the owner + resource),
    // a provider the running user hasn't connected may still be available via a
    // LENT connection from the owner (full delegation, resolved at dispatch).
    // isLentProvider lets the catalog OFFER those tools; the dispatch override in
    // chatStream/chatWithAgent then runs them as the owner. Inert unless
    // INTEGRATION_CONNECTION_LENDING_ENABLED is set AND a policy is passed — and
    // only agent paths that ALSO apply the dispatch override pass a policy.
    let _lendCtx = undefined;
    const _cr = require('./connectionResolution');
    const _lendingOn = _cr.isLendingEnabled() && connectionPolicy && connectionPolicy.ownerUserId && connectionPolicy.ownerUserId !== userId;
    async function isLentProvider(provider) {
        if (!_lendingOn) return false;
        try {
            if (_lendCtx === undefined) _lendCtx = await _cr.runningUserContext(userId);
            const store = require('../../stores/integrationConnectionStore');
            const r = await store.resolveConnectionForRun({
                runningUserId: userId, runningUserOrgId: _lendCtx.orgId, runningUserGroups: _lendCtx.groups,
                ownerUserId: connectionPolicy.ownerUserId, provider,
                resourceType: connectionPolicy.resourceType || null, resourceId: connectionPolicy.resourceId || null,
            });
            return !!(r && r.mode === 'delegated');
        } catch (_) { return false; }
    }

    // Fireflies — requires user API key (or a lent connection)
    const hasFirefliesKey = !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)) || await isLentProvider('fireflies');
    if (!userSimpleMode && hasFirefliesKey && isAppOn('fireflies')) {
        addTools(FIREFLIES_TOOLS);
    }

    // YouTrack — requires user URL + token (or a lent connection)
    const hasYouTrackConfig = (!!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`))) || await isLentProvider('youtrack');
    if (hasYouTrackConfig && isAppOn('youtrack')) {
        addTools(YOUTRACK_TOOLS);
    }

    // Gamma — requires user API key (or a lent connection)
    const hasGammaKey = !!(await configStore.getSecret(`gamma_api_key_user_${userId}`)) || await isLentProvider('gamma');
    if (hasGammaKey && isAppOn('gamma')) {
        addTools(GAMMA_TOOLS);
    }

    // SignRequest — requires user subdomain + token (or a lent connection)
    const hasSignRequestConfig = (!!(await configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`signrequest_token_user_${userId}`))) || await isLentProvider('signrequest');
    if (hasSignRequestConfig && isAppOn('signrequest')) {
        addTools(SIGNREQUEST_TOOLS);
    }

    // AFAS Profit — requires user member number + AppConnector token. Deliberately
    // NOT lendable (no isLentProvider clause): ERP data stays bring-your-own.
    const hasAfasConfig = !!(await configStore.getSecret(`afas_token_user_${userId}`)) && !!(await configStore.getSecret(`afas_member_number_user_${userId}`));
    if (hasAfasConfig && isAppOn('afas-profit')) {
        addTools(AFAS_TOOLS);
    }

    // NMBRS — read-only payroll/HR. Requires subdomain + token (and login email
    // for the SOAP API). Bring-your-own like AFAS: payroll data is not lendable.
    const hasNmbrsConfig = !!(await configStore.getSecret(`nmbrs_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`nmbrs_token_user_${userId}`));
    if (hasNmbrsConfig && isAppOn('nmbrs')) {
        addTools(NMBRS_TOOLS);
    }

    // vPlan — read-only planning data. Requires the API key + environment pair.
    // Bring-your-own like AFAS/NMBRS (no isLentProvider clause): one vPlan API key
    // unlocks the whole environment, so lending it would over-share.
    const hasVplanConfig = !!(await configStore.getSecret(`vplan_api_key_user_${userId}`)) && !!(await configStore.getSecret(`vplan_api_env_user_${userId}`));
    if (hasVplanConfig && isAppOn('vplan')) {
        addTools(VPLAN_TOOLS);
    }

    // Scaleway Billing — read-only invoices. The secret key is required; the
    // organization id is optional. Bring-your-own (no isLentProvider clause):
    // a lent key would show one org's Scaleway bill to another.
    const hasScalewayBillingConfig = !!(await configStore.getSecret(`scaleway_billing_secret_key_user_${userId}`));
    if (hasScalewayBillingConfig && isAppOn('scaleway-billing')) {
        addTools(SCALEWAY_BILLING_TOOLS);
    }

    // N8N workflows — org-level config. Read/run tools are implicit for every
    // member once the org has n8n configured (umbrella 'n8n' toggle, handled by
    // AUTO_ENABLED_APPS so legacy users with stale enabledApps lists don't lose
    // access). Only the write-bucket is permission-gated via modify_n8n_workflows.
    try {
        if (!userSimpleMode && userOrgId) {
            n8nOrgId = userOrgId;
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            if (n8nUrl && n8nKey && isAppOn('n8n')) {
                const canModify = await hasPermission(userId, 'modify_n8n_workflows', session);

                // Dynamic webhook-trigger tools — umbrella gating.
                // A user who has 'n8n' enabled (or is covered by AUTO_ENABLED_APPS)
                // gets every configured workflow, no per-workflow toggle required.
                //
                // Through addTools, like every other app. These two loops used
                // to push straight onto `tools`, which is the one thing that
                // walks past the per-action grant filter: an agent curated
                // down to `n8n_workflow_list` was handed all fifteen — delete,
                // execute and activate included — while the picker showed the
                // narrow list back and `isToolAllowed` agreed with the picker.
                // A grant that is storable, validated against the registry and
                // enforced nowhere is worse than no grant at all.
                const n8nTools = await buildN8nTools(n8nOrgId);
                const cleanN8nTools = [];
                for (const n8nTool of n8nTools) {
                    const { _n8n, ...cleanTool } = n8nTool;
                    cleanN8nTools.push(cleanTool);
                }
                // Per-workflow webhook names are not in the tool registry, so
                // no app claims them and no per-action grant speaks about them
                // — the documented hole in the grant layer, not a new one.
                addTools(cleanN8nTools);

                // Workflow-management tools — split by permission bucket:
                //   read-only (list/get/nodes_find/execution reads) → always included
                //   write / execute / delete / activate             → modify_n8n_workflows
                // The RBAC bucket first (it is about the person), then the
                // grants inside addTools (they are about the agent).
                addTools(N8N_WORKFLOW_TOOLS.filter(
                    t => !(getN8nToolPermission(t.function.name) === 'modify_n8n_workflows' && !canModify),
                ));
            }
        }
    } catch (e) {
        log.error('[IntegrationTools] n8n tool injection error:', e.message);
    }

    // Regex Generator — admin only
    if (!userSimpleMode && isAdmin) {
        addTools(REGEX_GENERATOR_TOOLS);
    }

    // Workspace/Notebook — check feature flag (disabled from admin panel = no tools)
    const notebooksFeatureEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
    if (!userSimpleMode && notebooksFeatureEnabled) {
        // BFSF-207: notebook tools mirror the HTTP surface gates — `notebooks`
        // capability via the unified resolver (same as requireCapability on
        // /api/notebooks + /api/ai/chat/notebook) AND the use_notebooks RBAC
        // permission (same as routes/notebooks.js). Fail closed on a missing/
        // degraded snapshot (matches the MCP fail-closed posture below).
        let notebooksEntitled = false;
        try {
            const entitlements = require('../entitlements/entitlements');
            notebooksEntitled = !!(entSnapshot && !entSnapshot.degraded && entitlements.snapshotHas(entSnapshot, 'notebooks'));
        } catch (_) { notebooksEntitled = false; }
        if (notebooksEntitled && await hasPermission(userId, 'use_notebooks', session)) {
            addTools(WORKSPACE_TOOLS);
        }
    }

    // Presentations — a first-party artefact tool like create_document: builds
    // a real .pptx in the org's house style and hands back a download link.
    // No credentials, no org toggle; the simple mode is the only switch.
    if (!userSimpleMode) {
        addTools(require('../../integrations/presentationTools').PRESENTATION_TOOLS);
        // Word documents — the same footing: a real .docx in the org's Word
        // house style, kept in storage (or Nextcloud) behind a download link.
        addTools(require('../../integrations/wordDocumentTools').WORD_DOCUMENT_TOOLS);
    }

    // Personal memory — the user's own user_memories, read and written through
    // two tools. First-party and org-exempt; the per-user enabled-apps
    // preference is the only switch (memory itself is governed by the memory
    // settings, which the tools honour by reading through memoryStore).
    if (isAppOn('memory')) {
        addTools(require('../../integrations/memoryTools').MEMORY_TOOLS);
    }
    // Automation evolution — automation steps only (never chat): an automation proposes
    // and, after approval, applies changes to its OWN definition.
    if (automationStep && isAppOn('automation-evolution')) {
        addTools(require('../../integrations/automationEvolutionTools').AUTOMATION_EVOLUTION_TOOLS);
    }

    // KB Search — available when agent has knowledge bases configured
    // This lets agents explicitly search KB with custom queries (e.g., after reading an email)
    if (agentConfig?.knowledge_base_ids?.length > 0) {
        addTools(KB_SEARCH_TOOLS);
    }

    // Datatable as knowledge — `datatable_query`, read-only and LIVE (A1c).
    // Built HERE rather than in getAgentTools because the definition depends on
    // the person ASKING: every granted table is resolved as them and the ones
    // they may not read are left out, so no table name reaches a model through
    // a tool description the asker could not have opened themselves.
    // Costs nothing for an agent whose owner granted no table — the grants map
    // is checked before any database work.
    try {
        const { buildDatatableTools } = require('../tools/datatableTools');
        addTools(await buildDatatableTools({ userId, agentConfig }));
    } catch (e) {
        // One tool, not the toolbelt: an exception escaping here is caught by
        // toolStackAssembly, which drops EVERY integration tool for the turn.
        log.warn('[IntegrationTools] datatable_query unavailable:', e.message);
    }

    // KB Ingest — automation-only WRITE tool (Support Studio "solved tickets → KB"
    // template). Never surfaced to chat agents (automationStep gate) and only to
    // holders of the org-level support_inbox permission.
    if (automationStep && isAppOn('kb-ingest') && await hasPermission(userId, 'support_inbox', session)) {
        addTools(KB_INGEST_TOOLS);
    }

    // LinkedIn — requires user OAuth tokens (or a lent connection)
    const hasLinkedIn = !!(await configStore.getSecret(`linkedin_access_token_user_${userId}`)) || await isLentProvider('linkedin');
    if (hasLinkedIn && isAppOn('linkedin')) {
        addTools(LINKEDIN_TOOLS);
    }

    // Withings — requires an OAuth credential in the automation vault. Health data
    // is GDPR Article 9 special category, so it is deliberately NOT lendable:
    // no isLentProvider clause, and a teammate borrowing an owner's connection
    // must never inherit their body measurements.
    if (isAppOn('withings')) {
        const automationCredentialStore = require('../../stores/automationCredentialStore');
        const withingsCred = await automationCredentialStore.getCredential(userId, 'withings').catch(() => null);
        if (withingsCred?.status === 'active') addTools(WITHINGS_TOOLS);
    }

    // Google Maps — requires Maps API key
    const hasMapsKey = !!(await configStore.getSecret('google_maps_api_key'));
    if (hasMapsKey && isAppOn('google-maps')) {
        addTools(MAPS_TOOLS);
    }

    // GitHub — requires user PAT (or a lent connection)
    const hasGitHub = !!(await configStore.getSecret(`github_token_user_${userId}`)) || await isLentProvider('github');
    if (hasGitHub && isAppOn('github')) {
        addTools(GITHUB_TOOLS);
    }

    // Nextcloud — OAuth path (parity with Google/Microsoft above) with
    // app-password fallback for users not logged in via Nextcloud OAuth.
    // Once a Nextcloud connection (either mode) is established, every
    // sub-app (files, calendar, contacts, Deck, notifications) gates on its
    // own per-app toggle so admins can disable individual surfaces.
    try {
        const oauthCfg = (await configStore.getConfig('oauth')) || {};
        // Connector-bound user: NC tools route through the connector's /nc/*
        // proxy with AppAPI shared-secret + impersonation. No OAuth URL or
        // app password is required; the org's nc_base_url is the binding.
        let isConnectorUser = session?.user?.provider === 'nextcloud_connector'
            || !!session?.connectorOrgId;
        if (!isConnectorUser) {
            // The binding is org-level, not session-level: a standalone or
            // bridged cookie session (org admins in a normal browser) carries
            // none of the connector extras, but the DB row + org still bind
            // the user to a Nextcloud instance. Without this check those users
            // are never offered any NC tool.
            try {
                const ncClient = require('../../integrations/nextcloudClient');
                isConnectorUser = !!(await ncClient.resolveNcBinding(session, userId));
            } catch (_) { /* store unavailable — fall through to URL/app-password */ }
        }
        // A user who saved their own app password may also carry a per-user
        // Nextcloud URL (Settings → Connections), which makes NC reachable even
        // when the org-wide oauth.nextcloudUrl is unset. Look it up once so it
        // can both open the gate and signal the connection.
        const userStoreLocal = require('../../stores/userStore');
        const ncCreds = isConnectorUser ? null : await userStoreLocal.getAppPassword(userId);
        const hasNcUrl = !!(oauthCfg.nextcloudUrl || ncCreds?.url);
        if (hasNcUrl || isConnectorUser) {
            let nextcloudConnected = false;
            if (isConnectorUser) {
                nextcloudConnected = true;
            } else if (session?.oauthProvider === 'nextcloud' && session?.accessToken) {
                nextcloudConnected = true;
            } else if (ncCreds?.username && ncCreds?.password) {
                nextcloudConnected = true;
            }
            if (nextcloudConnected) {
                // Per-user scope, Layer 1 (UX): families the user switched
                // OFF are not even offered to the model. Resolved AFTER
                // isAppOn's entitlement/org gates and only ever subtracts
                // from them — the authoritative enforcement (incl. the org
                // ceiling and per-resource selections) lives in
                // toolDispatcher via ncScopeGuard, so a miss here can only
                // cost a denied call, never grant one.
                let scopeOn = () => true;
                try {
                    const { resolveNcScope } = require('./ncScope');
                    // orgId matters: the org ceiling is where the admin's own
                    // Nextcloud toggles live. Without it a family the org
                    // turned off would still be offered to the model, which
                    // would call it and be refused by the guard — correct,
                    // but a wasted turn and a confusing refusal.
                    const ncScope = await resolveNcScope({ userId, orgId: userOrgId });
                    scopeOn = (id) => ncScope[id]?.mode !== 'off';
                } catch (_) { /* Layer 2 still enforces — keep offering */ }
                if (scopeOn('nextcloud') && isAppOn('nextcloud')) addTools(NEXTCLOUD_TOOLS);
                if (scopeOn('nextcloud-calendar') && isAppOn('nextcloud-calendar')) addTools(NEXTCLOUD_CALENDAR_TOOLS);
                if (scopeOn('nextcloud-contacts') && isAppOn('nextcloud-contacts')) addTools(NEXTCLOUD_CONTACTS_TOOLS);
                if (scopeOn('nextcloud-deck') && isAppOn('nextcloud-deck')) addTools(NEXTCLOUD_DECK_TOOLS);
                if (scopeOn('nextcloud-notifications') && isAppOn('nextcloud-notifications')) addTools(NEXTCLOUD_NOTIFICATIONS_TOOLS);
                if (scopeOn('nextcloud-talk') && isAppOn('nextcloud-talk')) addTools(NEXTCLOUD_TALK_TOOLS);
                if (scopeOn('nextcloud-tasks') && isAppOn('nextcloud-tasks')) addTools(NEXTCLOUD_TASKS_TOOLS);
                if (scopeOn('nextcloud-notes') && isAppOn('nextcloud-notes')) addTools(NEXTCLOUD_NOTES_TOOLS);
                if (scopeOn('nextcloud-mail') && isAppOn('nextcloud-mail')) addTools(NEXTCLOUD_MAIL_TOOLS);
                if (scopeOn('nextcloud-activity') && isAppOn('nextcloud-activity')) addTools(NEXTCLOUD_ACTIVITY_TOOLS);
                if (scopeOn('nextcloud-tables') && isAppOn('nextcloud-tables')) addTools(NEXTCLOUD_TABLES_TOOLS);
                if (scopeOn('nextcloud-forms') && isAppOn('nextcloud-forms')) addTools(NEXTCLOUD_FORMS_TOOLS);
                if (scopeOn('nextcloud-teams') && isAppOn('nextcloud-teams')) addTools(NEXTCLOUD_TEAMS_TOOLS);
                if (scopeOn('nextcloud-status') && isAppOn('nextcloud-status')) addTools(NEXTCLOUD_STATUS_TOOLS);
            }
        }
    } catch (e) { /* ignore — credentials missing or store unavailable */ }

    // Transcription — requires existing Mistral API key
    const hasMistralKey = !!(await configStore.getSecret('mistral_api_key'));
    if (hasMistralKey && isAppOn('transcription')) {
        addTools(TRANSCRIPTION_TOOLS);
    }

    // Webpages (automation-flavoured surface). Gated ONLY on webpageToolsAllowed
    // (the "webpages" beta feature, or access to a webpage) — deliberately NOT
    // also on isAppOn('webpages'). buildUserAppGate asks the same helper, so
    // the automation validator and this runtime cannot disagree.
    //
    // The beta feature is the real gate for the whole Webpages capability: it's
    // what unlocks the Studio app, what the DIRECT webpage chat gates on
    // (routes/ai/webpageChat.js injects its builder tools on the beta feature
    // alone), and what the automations catalog uses to decide availability
    // (routes/automation/catalog.js: `available = webpagesAvailable`). Requiring
    // the separate org-integration entitlement here too meant agents/automations
    // were advertised the webpage actions but then never actually received them
    // at runtime — so an agent could edit a webpage from the in-editor chat but
    // not from a normal agent conversation. Gating all three surfaces on the
    // same beta feature fixes that. (Dispatch stays distinct: direct chat checks
    // isBuilderTool/isDbTool first; agents + the automation runner go through
    // toolDispatcher → isWebpageAutomationTool, which re-checks canWriteWebpage
    // per call, so this is not a fail-open — writes still require ownership or a
    // share into the caller's org/group.)
    if (await webpageToolsAllowed({
        userId, session, groupIds: resolvedUserGroupIds, orgId: userOrgId, simpleMode: userSimpleMode,
    })) {
        addTools(WEBPAGE_AUTOMATION_TOOLS);
    }

    // MCP servers are integrations (id `mcp:<serverId>`). Gate them by the same
    // effective.integration set computed above — single path, no duplication.
    // `isToolGranted` reaches these too: an MCP tool name is not in the tool
    // registry, so without passing the filter down an agent curated to two
    // Gmail actions would still receive every tool of every connected server.
    await appendMcpTools(tools, { effectiveIntegrations, isToolGranted: _isToolGranted });

    // Org-scoped custom integrations (AI Integration Builder, id
    // `custom:<uuid>`) — same effective-set gate; the dark-ship feature flag
    // is enforced inside the helper.
    await appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId: userOrgId, isToolGranted: _isToolGranted });

    // Agent-callable automations (automations with trigger.kind === 'agent_call').
    // Each active one the user owns becomes a function tool the model can call
    // from direct chat or a configured agent. Gated by the same 'automations'
    // capability the scheduler checks — fail closed if the org lacks it or the
    // lookup throws, so we never surface automations on installs without automations.
    //
    // NARROWED for a CURATED agent. This exposure is keyed to the ASKER, so it
    // hands an agent every active automation of whoever happens to be chatting —
    // which is precisely what the per-agent grant list replaces. So an agent
    // that declares `config.tools.automations` keeps only the automations its
    // OWNER granted, whoever is asking; direct chat (no agentConfig) is
    // untouched, and so is an agent nobody has curated yet.
    //
    // It NARROWS rather than suppresses on purpose. Suppressing the whole set
    // here only made sense if a curated set were injected somewhere else, and
    // nothing injected one: the first person to write `config.tools.automations`
    // lost every automation the agent could call, including the one they had just
    // granted. Filtering the caller's own set by the granted ids needs no
    // second injector and cannot widen — an automation the asker does not have is
    // simply not in the list to keep.
    const _plainObjectLike = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const _automationGrants = (() => {
        try {
            const p = require('../agentRuntime/toolPolicy');
            return p.automationGrantsOf(p.toolsConfigOf(agentConfig));
        } catch (_) { return null; }        // policy unreadable — decided below
    })();
    // With the policy module gone we cannot read the grants, but we can still
    // see whether there ARE any: a section that is there carries a decision,
    // and "I could not read the owner's list" is not permission to offer the
    // asker's whole one.
    // De AANWEZIGHEID van de sectie is de keuze, niet de inhoud. Een lege
    // sectie betekent "ik heb alle automatiseringen uitgevinkt" en levert dus geen
    // enkele automation op. Zou leeg als ongecureerd gelden, dan gaf uitvinken
    // juist de volledige lijst van de vrager terug — het tegenovergestelde
    // van wat de eigenaar aanklikte. De normalisatie bewaart die lege sectie
    // daarom bewust (zie toolPolicy.normaliseToolsConfig).
    // De AANWEZIGHEID van de sleutel is de keuze — ook als hij naar een lege
    // map wijst, en ook als hij onleesbaar is. Alleen een agent bij wie
    // niemand de sectie ooit heeft aangeraakt krijgt de oude, volledige lijst.
    const _curatedAutomations = !!(agentConfig && _plainObjectLike(agentConfig.tools)
        && Object.prototype.hasOwnProperty.call(agentConfig.tools, 'automations'));
    try {
        if (_curatedAutomations && !_automationGrants) {
            log.warn('[IntegrationTools] Automation grants unreadable — offering no agent-callable automations');
            throw { __skip: true };
        }
        const { hasCapability } = require('../entitlements/entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        if (await hasCapability('automations', { userId, orgId: resolveOrgId })) {
            const { getAgentCallableToolsForUser } = require('../../automation/agentCallableTools');
            const agentTools = await getAgentCallableToolsForUser(userId);
            for (const t of agentTools) {
                if (_curatedAutomations) {
                    // Fail closed on a definition with no id: the grant is
                    // keyed on the automation id, so a tool that cannot show
                    // one cannot be matched against the owner's list.
                    const id = t && t.__automation && t.__automation.id;
                    if (!id || !Object.prototype.hasOwnProperty.call(_automationGrants, id)) continue;
                }
                if (!tools.find(x => x?.function?.name === t?.function?.name)) tools.push(t);
            }
        }
    } catch (e) {
        log.warn('[IntegrationTools] Failed to load agent-callable automations:', e.message);
    }

    // Reusable Steps (kind='block') the user published and marked "available in
    // chat". Owner-only in v1 (mirrors agent_call), so the Step runs under the
    // caller's own identity. Same 'automations' capability gate.
    try {
        const { hasCapability } = require('../entitlements/entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        if (await hasCapability('automations', { userId, orgId: resolveOrgId })) {
            const { getStepToolsForUser } = require('../../automation/agentCallableTools');
            const stepTools = await getStepToolsForUser(userId);
            for (const t of stepTools) {
                if (!tools.find(x => x?.function?.name === t?.function?.name)) tools.push(t);
            }
        }
    } catch (e) {
        log.warn('[IntegrationTools] Failed to load Step tools:', e.message);
    }

    return { tools, n8nOrgId };
}

/**
 * Append connected MCP-server tools to a tool list, gated by the caller's
 * effective integration set. Shared by getIntegrationTools (running user) and
 * agentRuntime/agentTools (agent owner) so the gating lives in ONE place.
 *
 *   effectiveIntegrations : Set<string> of granted integration ids, or null.
 *     null ⇒ fail-closed (no MCP tools) — the resolver was unavailable/degraded.
 *   Each MCP server `mcp:<id>` must be present in the set to expose its tools.
 *   (No tier/umbrella gate — MCP servers are plain integrations.)
 */
async function appendMcpTools(tools, { effectiveIntegrations, isToolGranted = null }) {
    if (!effectiveIntegrations) return; // fail closed
    try {
        const mcpManager = require('../mcpManager');
        const mcpTools = await mcpManager.getAllToolsAsOpenAI();
        for (const t of mcpTools) {
            const serverId = t._mcp?.serverId;
            if (!serverId) continue;                                  // unidentifiable ⇒ fail closed
            if (!effectiveIntegrations.has(`mcp:${serverId}`)) continue;
            if (isToolGranted && !isToolGranted(t)) continue;         // per-action grant
            if (!tools.find(x => x.function?.name === t.function?.name)) tools.push(t);
        }
    } catch (e) {
        log.warn('[IntegrationTools] MCP injection failed:', e.message);
    }
}

/**
 * MCP server ids this user could actually observe events from: their tools
 * survived the `mcp:<id>` capability gate into `toolNames`, AND the user has
 * supplied every credential the server requires.
 *
 * Both terms are needed. `tools_cache` is server-global and appendMcpTools does
 * no credential check, so a granted-but-uncredentialled user would otherwise be
 * offered a trigger that can never poll anything.
 *
 * Used to resolve `{ kind: 'mcp' }` availability for app_event trigger
 * providers, which cannot use the app-id path: MCP servers have no
 * TOOL_REGISTRY row and so never appear in the catalog's availableAppIds.
 *
 * Matches server ids forward onto tool names rather than parsing ids back out
 * of them — getAllToolsAsOpenAI sanitises the whole name ([^A-Za-z0-9_] → _),
 * so a hyphenated id is not recoverable from the tool name.
 *
 * Returns booleans only; no secret value ever leaves this function. Any failure
 * yields an empty set (fail closed) — it can only ever hide a provider.
 */
async function availableMcpServerIds(toolNames, userId) {
    const out = new Set();
    if (!userId || !(toolNames instanceof Set) || toolNames.size === 0) return out;
    try {
        const mcpManager = require('../mcpManager');
        for (const server of await mcpManager.getServersForUser(userId)) {
            if (!server?.id || !server.allConfigured) continue;
            const prefix = `mcp_${server.id}_`.replace(/[^a-zA-Z0-9_]/g, '_');
            for (const name of toolNames) {
                if (typeof name === 'string' && name.startsWith(prefix)) { out.add(server.id); break; }
            }
        }
    } catch (e) {
        log.warn('[IntegrationTools] MCP trigger availability failed:', e.message);
        return new Set();
    }
    return out;
}

/**
 * Append org-scoped custom-integration tools (AI Integration Builder) to a
 * tool list, gated by the caller's effective integration set. Shared by
 * getIntegrationTools (running user) and agentRuntime/agentTools (agent
 * owner) so the gating lives in ONE place.
 *
 *   effectiveIntegrations : Set<string> of granted capability ids, or null.
 *     null ⇒ fail-closed (no custom tools) — the resolver was unavailable/degraded.
 *   orgId : the user's OWN org — custom integrations are org-scoped, so a
 *     missing org (or the '__system__' super-admin scope) means none exist.
 *   Each integration `custom:<uuid>` must be present in the set to expose its
 *   tools_cache entries (already OpenAI-format with cint_-prefixed names,
 *   frozen at activation — including any `_cint` metadata they carry).
 *   The run gate (customIntegrations/mcpLibrary/gate.js) is re-checked here
 *   per row: the builder's dark-ship flag for builder rows, the server-wide
 *   org MCP policy for MCP-library rows. Flipping either off removes
 *   injection without touching callers.
 */
async function appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId, isToolGranted = null }) {
    if (!effectiveIntegrations) return; // fail closed
    if (!orgId || orgId === '__system__') return; // org-scoped feature — no org, no tools
    try {
        const { loadRunGate } = require('../customIntegrations/mcpLibrary/gate');
        const gate = await loadRunGate();
        if (!gate.anyRunnable) return; // both families switched off
        const store = require('../../stores/orgCustomIntegrationStore');
        const rows = await store.listActiveForOrg(orgId);
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || !row.id) continue;                            // unidentifiable ⇒ fail closed
            if (!gate.isRunnable(row)) continue;
            if (!effectiveIntegrations.has(`custom:${row.id}`)) continue;
            for (const entry of Array.isArray(row.toolsCache) ? row.toolsCache : []) {
                const name = entry?.function?.name;
                if (!name) continue;                                  // unidentifiable ⇒ fail closed
                // Per-action grants key on `custom:<id>`; the cached tool
                // definitions do not carry it, so stamp it on for the check.
                if (isToolGranted && !isToolGranted({ ...entry, _custom: { integrationId: row.id } })) continue;
                if (!tools.find(x => x.function?.name === name)) tools.push(entry);
            }
        }
    } catch (e) {
        log.warn('[IntegrationTools] Custom integration injection failed:', e.message);
    }
}

/**
 * Build human-readable integration hints for the system prompt.
 * @param {Array} tools - Tool definitions array
 * @returns {string} Integration hint string to append to system prompt
 */
async function buildToolHint(tools, _userId = null) {
    if (tools.length === 0) return '';

    const integrations = [];
    if (tools.some(t => t.function.name.startsWith('gmail_'))) integrations.push('Gmail (search, read, compose, send, and reply to emails — the user approves before anything is sent)');
    if (tools.some(t => t.function.name.startsWith('calendar_'))) integrations.push('Google Calendar (list, search, create, update, delete events)');
    if (tools.some(t => t.function.name.startsWith('drive_'))) integrations.push('Google Drive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('docs_'))) integrations.push('Google Docs (create, read, append, replace text in documents)');
    if (tools.some(t => t.function.name.startsWith('contacts_'))) integrations.push('Google Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name.startsWith('keep_'))) integrations.push('Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)');
    if (tools.some(t => t.function.name.startsWith('groups_'))) integrations.push('Google Groups (list conversations in a group, read full conversation threads, reply to group conversations — replies require user approval before sending)');
    if (tools.some(t => t.function.name.startsWith('youtrack_'))) integrations.push('YouTrack (search, create, update & link issues, read comments, find users, change assignee, log work, manage tags — always search for an existing issue before creating one)');
    if (tools.some(t => t.function.name.startsWith('afas_'))) integrations.push('AFAS Profit (discover GetConnectors with afas_list_connectors, inspect fields with afas_describe_connector, then read data with afas_query; read-only)');
    if (tools.some(t => t.function.name.startsWith('nmbrs_'))) integrations.push('NMBRS payroll/HR (read-only: list debtors → companies → employees with nmbrs_list_*, then read an employee\'s contracts, salaries, wage components and payslips)');
    if (tools.some(t => t.function.name.startsWith('vplan_'))) integrations.push('vPlan (read-only planning: start with vplan_list_boards for board/stage/status/label IDs, then vplan_list_cards, vplan_list_collections, vplan_get_capacity, vplan_get_resource_availability and vplan_time_tracking_summary)');
    if (tools.some(t => t.function.name.startsWith('scaleway_'))) integrations.push('Scaleway Billing (read-only invoices: scaleway_list_invoices lists them per billing period; inside an automation, scaleway_download_invoice fetches the PDF and returns a sourceHandle to pass to nextcloud_upload_file or drive_upload_file)');
    if (tools.some(t => t.function.name.startsWith('signrequest_'))) integrations.push('SignRequest (send documents for e-signature, check signing status, list documents, cancel requests)');
    if (tools.some(t => t.function.name.startsWith('fireflies_'))) integrations.push('Fireflies (meeting transcripts)');
    if (tools.some(t => t.function.name.startsWith('gamma_'))) integrations.push('Gamma (create presentations/documents/webpages/social posts, generate from templates using gammaId or a pasted gamma.app/docs URL, poll generation status, list themes/folders; create tools start asynchronous jobs and return generationId first, then use gamma_get_generation_status to retrieve gammaUrl/exportUrl; existing Gammas cannot be read by URL or edited in place via the public API. If the user asks to create/remix a new Gamma from a URL, call gamma_create_from_template instead of saying the URL cannot be used)');
    if (tools.some(t => t.function.name.startsWith('n8n_run_'))) {
        const n8nNames = tools.filter(t => t.function.name.startsWith('n8n_run_')).map(t => t.function.description || t.function.name);
        integrations.push(`n8n Workflows (${n8nNames.join(', ')})`);
    }
    if (tools.some(t => t.function.name.startsWith('n8n_workflow_') || t.function.name.startsWith('n8n_execution_'))) {
        const hasWrite = tools.some(t => ['n8n_workflow_create','n8n_workflow_update','n8n_workflow_patch','n8n_workflow_delete','n8n_workflow_execute','n8n_workflow_activate','n8n_workflow_deactivate'].includes(t.function.name));
        if (hasWrite) {
            integrations.push(
                'n8n Workflow Management (list, get, nodes_find, create, patch, activate, execute, debug executions). RULES: '
                + '(1) ALWAYS call n8n_workflow_list first to discover IDs — never guess a workflow_id. '
                + '(2) For targeted edits use n8n_workflow_patch with node_operations {action,node_name,node_data} — NOT wholesale update. '
                + '(3) For searching nodes use n8n_workflow_nodes_find instead of pulling the full workflow. '
                + '(4) nodes/connections/parameters are real JSON arrays/objects, never stringified. '
                + '(5) Do NOT send `settings` in a patch unless explicitly changing one — the server preserves/sanitises existing settings automatically. '
                + '(6) To add documentation to the canvas, use sticky notes: type "n8n-nodes-base.stickyNote" with parameters.content — no connections needed. '
                + '(7) Always confirm with the user before n8n_workflow_delete or n8n_workflow_activate. '
                + '(8) On failure, debug via n8n_execution_list → n8n_execution_get_detail for per-node errors.'
            );
        } else {
            integrations.push('n8n Workflow Inspection (list, get, nodes_find, execution_list, execution_get_detail — read-only). To modify workflows you need the "Modify n8n Workflows" permission.');
        }
    }
    if (tools.some(t => t.function.name === 'generate_image')) integrations.push('Image generation');
    if (tools.some(t => t.function.name === 'create_presentation')) integrations.push('Presentations (create_presentation builds a real .pptx deck and returns a download link you must put in your reply; nextcloud_create_presentation saves it into Nextcloud so it opens in Nextcloud Office)');
    if (tools.some(t => t.function.name === 'create_word_document')) integrations.push('Word documents (create_word_document builds a real, editable .docx in the organisation\'s Word house style and returns a download link you must put in your reply; with nextcloudPath it is saved into Nextcloud instead)');
    if (tools.some(t => t.function.name === 'generate_music')) integrations.push('Music generation (instrumental AI music via Lyria)');
    if (tools.some(t => t.function.name === 'generate_video')) integrations.push('Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)');
    if (tools.some(t => t.function.name === 'agent_search')) integrations.push('Agent Search (AI-powered web search with reranking)');
    if (tools.some(t => t.function.name === 'browse_web')) integrations.push('Browse Web (open and read/interact with live web pages in a real headless browser — navigate, click, type, follow links across pages. Use it whenever the user gives a URL, or a task needs live/JS-rendered content. When you already have a URL, use browse_web directly — do NOT use agent_search for a known URL; agent_search is only for discovering pages when you have no URL)');
    if (tools.some(t => t.function.name.startsWith('workspace_') || t.function.name.startsWith('notebook_'))) integrations.push('Notebook (read and write a persistent rich-text document alongside the conversation)');
    if (tools.some(t => t.function.name === 'kb_search')) integrations.push('Knowledge Base Search (look up internal documentation when the user asks a specific question — do NOT search for greetings or small-talk)');
    if (tools.some(t => t.function.name.startsWith('maps_'))) integrations.push('Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)');
    if (tools.some(t => t.function.name.startsWith('linkedin_'))) integrations.push('LinkedIn (create posts — user approves before publishing)');
    if (tools.some(t => t.function.name.startsWith('github_'))) integrations.push('GitHub (list repos, view code, create repos, manage branches)');
    if (tools.some(t => t.function.name.startsWith('outlook_'))) {
        // Check if compose tool is present — if not, it's read-only mode
        const hasCompose = tools.some(t => t.function.name === 'outlook_compose');
        if (hasCompose) {
            integrations.push('Outlook Mail (search, list recent, read, compose, send, and reply to emails — the user approves before anything is sent)');
        } else {
            integrations.push('Outlook Mail (search, list recent, and read emails only — read-only access, no sending capability)');
        }
    }
    if (tools.some(t => t.function.name.startsWith('ms_calendar_'))) integrations.push('Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('onedrive_'))) integrations.push('OneDrive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('ms_contacts_'))) integrations.push('Microsoft Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name === 'transcribe_audio')) integrations.push('Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_calendar_'))) integrations.push('Nextcloud Calendar (list calendars, list/search/get events, create/update/delete events via CalDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_contacts_'))) integrations.push('Nextcloud Contacts (list address books, list/search/get contacts, create/update/delete contacts via CardDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_deck_'))) integrations.push('Nextcloud Deck (list boards/stacks/cards, search cards, create/update/move/archive/delete cards, manage labels, add comments — create/update/move require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notifications_'))) integrations.push('Nextcloud Notifications (list pending notifications, dismiss one or all — dismiss-all always requires user confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_talk_'))) integrations.push('Nextcloud Talk (list conversations, list/search messages, post messages with optional reply, react with emoji, mark rooms read, create rooms — sending messages always requires user approval, deletion always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_tasks_'))) integrations.push('Nextcloud Tasks (VTODO via CalDAV — list lists, list/search/get tasks, create, update, mark complete/incomplete, delete — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notes_'))) integrations.push('Nextcloud Notes (list/search/get notes, create/update/delete notes, list categories — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_activity_'))) integrations.push('Nextcloud Activity (read-only feed of recent file changes, shares, comments, mentions, calendar invites — useful for "what happened recently?" questions)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud User Status (get / set / clear the user\'s availability and custom message — setting status requires user approval, except when auto-deriving from a calendar event the user explicitly asked about)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_') && !t.function.name.startsWith('nextcloud_calendar_') && !t.function.name.startsWith('nextcloud_contacts_') && !t.function.name.startsWith('nextcloud_deck_') && !t.function.name.startsWith('nextcloud_notifications_') && !t.function.name.startsWith('nextcloud_talk_') && !t.function.name.startsWith('nextcloud_tasks_') && !t.function.name.startsWith('nextcloud_notes_') && !t.function.name.startsWith('nextcloud_activity_') && !t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud Files (list/search/read/upload/delete files, create folders, share with public links / users / groups / email, manage shares, file comments, system tags, trash bin recovery, file version history via WebDAV — destructive ops require user approval, permanent deletes always require confirmation)');

    // MCP (Model Context Protocol) tools — dynamically discovered from connected external servers
    const mcpTools = tools.filter(t => t.function?.name?.startsWith('mcp_'));
    log.info(`[MCP-DEBUG] buildToolHint: ${tools.length} total tools received, ${mcpTools.length} are MCP tools`);
    if (mcpTools.length > 0) {
        // Group by server: mcp_{serverId}_{toolName}
        const serverMap = {};
        for (const t of mcpTools) {
            const parts = t.function.name.split('_');
            // mcp_{serverId}_{rest...} — server ID is the second segment
            const serverId = parts[1] || 'unknown';
            if (!serverMap[serverId]) serverMap[serverId] = [];
            serverMap[serverId].push(t.function.description || t.function.name);
        }
        log.info(`[MCP-DEBUG] buildToolHint: MCP servers found: ${Object.keys(serverMap).join(', ')}`);
        for (const [serverId, toolDescs] of Object.entries(serverMap)) {
            const label = serverId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            integrations.push(`${label} via MCP (${toolDescs.length} tools: ${toolDescs.slice(0, 5).join(', ')}${toolDescs.length > 5 ? `, ... and ${toolDescs.length - 5} more` : ''})`);
        }
    }

    // Custom org integrations (AI Integration Builder) — cint_<slug>_<tool>.
    // Cheap by construction: skipped entirely when no cint_ tools made it into
    // the list, one getBySlug lookup per distinct integration otherwise.
    // Fail-soft: a store hiccup only costs the hint line, never the tools.
    const cintTools = tools.filter(t => t.function?.name?.startsWith('cint_'));
    if (cintTools.length > 0) {
        try {
            const { parsePrefixedName } = require('../../integrations/customIntegrationRunner');
            const orgCustomIntegrationStore = require('../../stores/orgCustomIntegrationStore');
            const bySlug = new Map();
            for (const t of cintTools) {
                const parsed = parsePrefixedName(t.function.name);
                if (!parsed) continue;
                if (!bySlug.has(parsed.slug)) bySlug.set(parsed.slug, []);
                bySlug.get(parsed.slug).push(t.function.name);
            }
            for (const [slug, toolNames] of bySlug) {
                const row = await orgCustomIntegrationStore.getBySlug(slug);
                if (!row || !row.name) continue;
                integrations.push(`${row.name} (custom org integration: ${toolNames.join(', ')})`);
            }
        } catch (_) { /* fail soft — hint only, the tools themselves still work */ }
    }

    let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
    if (integrations.length > 0) {
        hint += ` Your available integrations: ${integrations.join(', ')}.`;
    }
    log.info(`[MCP-DEBUG] buildToolHint final integrations: [${integrations.join(', ')}]`);

    return hint;
}

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
 * browse_web is registered inline (see the docker-probe branch above), never via
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
    catch (_) { /* fail open at this layer only — org/group gates below still enforce */ }
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
        const entitlements = require('../entitlements/entitlements');
        const snap = await entitlements.resolveEntitlements({ userId, session });
        if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
        const capReg = require('../entitlements/capabilityRegistry');
        isKnownIntegration = (appId) => capReg.getCapability(appId)?.kind === 'integration';
    } catch (_) { effectiveIntegrations = null; /* fall back to the legacy org gate */ }
    try {
        const cat = require('./ncIntegrationCatalog');
        // ncIdSet was used only by the orgActiveSet gate (now dropped); kept require
        // for parity with getIntegrationTools and to surface load errors fast.
        void (cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []));
    } catch (_) { }
    // Inputs for the webpages rule, resolved the way getIntegrationTools does.
    let webpageGroupIds = [];
    let webpageOrgId = null;
    try {
        const userStore = require('../../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        if (currentUser?.organizationId) webpageOrgId = currentUser.organizationId;
        else if (isAdmin || session?.user?.role === 'admin') webpageOrgId = '__system__';
        if (currentUser?.organizationId) {
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults) : globalDefaults;
                }
            }
            // NOTE: orgActiveSet (the org-admin "active integrations" subset) is
            // intentionally NOT consulted here. That layer is a runtime override
            // for tool dispatch — when an org hasn't populated it (the default
            // on most installs incl. dev) it ends up as an empty Set which
            // erroneously hides EVERY non-NC, non-exempt app. Palette is design-
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
    } catch (_) { /* fail open */ }

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
        catch (_) { /* unknown → withhold webpages (fail closed), like a failed beta lookup */ }
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
        const { TOOL_REGISTRY } = require('../../automation/toolRegistry');
        for (const entry of TOOL_REGISTRY) {
            if (isAppOn(entry.app)) out.add(entry.app);
        }
    } catch (_) { /* registry unavailable */ }
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

module.exports = { getIntegrationTools, buildToolHint, getUserPermittedApps, isIntegrationPermittedForUser, webpageToolsAllowed, appendMcpTools, appendCustomIntegrationTools, availableMcpServerIds };
