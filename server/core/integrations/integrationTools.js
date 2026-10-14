/**
 * Integration Tools — Shared tool injection for direct chat and agent chat
 * 
 * Builds the list of available integration tools (Gmail, Calendar,
 * Docs, Drive, Fireflies, YouTrack, Gamma, N8N, Tavily, Image Gen,
 * Video Gen, Terminal, Regex Generator) based on user session,
 * org settings, and enabled apps.
 */

const configStore = require('../../stores/configStore');
const { resolveOrgAllowList, resolveOrgActiveSet } = require('./enabledIntegrations');
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
const log = require('../../telemetry/log');
const { userHasBetaFeature } = require('../entitlements/betaFeatures');
const { createWebpageToolsAllowed } = require('./integrationAppPolicy');
const { createRuntimeAppGate } = require('./runtimeAppGate');
const { createExternalToolInjection } = require('./externalToolInjection');
const { createBuildToolHint } = require('./toolHint');
const { createUserAppGate } = require('./userAppGate');

// The split-out modules import nothing from the server's large import cycle;
// their dependencies are handed in here (lint:scc-ratchet). Getters keep the
// lazy requires lazy; module objects are passed whole so a patched method
// (tests) is seen at call time, exactly as before the split.
const lazy = {
    userStore: () => require('../../stores/userStore'),
    webpageStore: () => require('../../stores/webpageStore'),
    entitlements: () => require('../entitlements/entitlements'),
    capabilityRegistry: () => require('../entitlements/capabilityRegistry'),
    mcpManager: () => require('../mcpManager'),
    mcpLibraryGate: () => require('../customIntegrations/mcpLibrary/gate'),
    orgCustomIntegrationStore: () => require('../../stores/orgCustomIntegrationStore'),
    customIntegrationRunner: () => require('../../integrations/customIntegrationRunner'),
};
const webpageToolsAllowed = createWebpageToolsAllowed({ userHasBetaFeature, lazy });
const resolveRuntimeAppGate = createRuntimeAppGate({ configStore, resolveOrgAllowList, resolveOrgActiveSet, lazy });
const { appendMcpTools, availableMcpServerIds, appendCustomIntegrationTools } = createExternalToolInjection({ lazy });
const buildToolHint = createBuildToolHint({ lazy });
const { getUserPermittedApps, isIntegrationPermittedForUser } = createUserAppGate({ configStore, resolveOrgAllowList, webpageToolsAllowed, lazy });

// The app-id lists (ORG_EXEMPT_APPS, AUTO_ENABLED_APPS) and webpageToolsAllowed
// live in integrationAppPolicy.js; the gate that folds them with the org,
// group and entitlement layers in runtimeAppGate.js; MCP / custom-integration
// injection in externalToolInjection.js; the system-prompt hint in
// toolHint.js; the design-time gate in userAppGate.js.

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
async function getIntegrationTools({ userId, session, isAdmin, agentConfig, agentId = null, automationStep = false, connectionPolicy = null, extraEnabledApps = null, enabledAppsOverride = null }) {
    const tools = [];
    let n8nOrgId = null;

    const { userSimpleMode, userOrgId, resolvedUserGroupIds, entSnapshot, effectiveIntegrations, isAppOn } =
        await resolveRuntimeAppGate({ userId, session, isAdmin, extraEnabledApps, enabledAppsOverride });

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
    // Shared with the Automation Builder's chat (webSearchAvailability.js), so
    // both offer web search on exactly the same installations. It includes the
    // node-search fallback for an agent-search provider without its GPU URL.
    const { available: searchAvailable, provider: searchProvider, fallbackToNode: canFallbackToNode } =
        await require('../../integrations/webSearchAvailability').webSearchProviderStatus({ configStore, env: process.env });
    if (searchAvailable && isAppOn('agent-search')) {
        // AGENT_SEARCH_TOOLS carries agent_search AND read_url (see agentSearchTools.js):
        // read_url is offered exactly where web search is.
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
    // They are reachable ONLY through the agent they are bound to
    // (automation_agent_bindings, automation/agentBinding.js): each active one
    // bound to `agentId` becomes a function tool the model can call. No agent,
    // no tool: direct chat, Cowork / AI tasks, voice without an agent and the
    // /mcp endpoint pass no `agentId` and are offered none. Gated by the same
    // 'automations' capability the scheduler checks, fail closed if the org
    // lacks it or the lookup throws, so we never surface automations on
    // installs without automations.
    //
    // The agent's own grant list (`config.tools.automations`) still NARROWS the
    // bound set for a CURATED agent: bound AND granted. It can only narrow; a
    // grant for an automation that is not bound to this agent offers nothing,
    // so a list written before the bindings existed cannot widen anything.
    //
    // The presence of the key is the choice, not its content: an empty section
    // means "I switched all automations off". Treating empty as uncurated
    // would hand back the whole bound set, the opposite of what the owner
    // clicked, so the normalisation keeps an empty section on purpose (see
    // toolPolicy.normaliseToolsConfig).
    const _plainObjectLike = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const _automationGrants = (() => {
        try {
            const p = require('../agentRuntime/toolPolicy');
            return p.automationGrantsOf(p.toolsConfigOf(agentConfig));
        } catch (_) { return null; }        // policy unreadable — decided below
    })();
    const _curatedAutomations = !!(agentConfig && _plainObjectLike(agentConfig.tools)
        && Object.prototype.hasOwnProperty.call(agentConfig.tools, 'automations'));
    try {
        if (!agentId) throw { __skip: true };   // nothing to look up: no agent, no automation tools
        if (_curatedAutomations && !_automationGrants) {
            log.warn('[IntegrationTools] Automation grants unreadable — offering no agent-callable automations');
            throw { __skip: true };
        }
        const { hasCapability } = require('../entitlements/entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        if (await hasCapability('automations', { userId, orgId: resolveOrgId })) {
            const { getAgentCallableTools } = require('../../automation/agentCallableTools');
            const agentTools = await getAgentCallableTools({ agentId });
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
        if (!(e && e.__skip)) log.warn('[IntegrationTools] Failed to load agent-callable automations:', e.message);
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

module.exports = { getIntegrationTools, buildToolHint, getUserPermittedApps, isIntegrationPermittedForUser, webpageToolsAllowed, appendMcpTools, appendCustomIntegrationTools, availableMcpServerIds };
