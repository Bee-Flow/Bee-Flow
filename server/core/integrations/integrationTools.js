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
const { hasPermission } = require('../../auth/permissions');
const { IMAGE_GEN_TOOLS } = require('../tools/imageGenTool');
const { VIDEO_GEN_TOOLS } = require('../tools/videoGenTool');
const { ELEVENLABS_TOOLS } = require('../tools/elevenLabsTools');
const log = require('../../telemetry/log');
const { featureModule } = require('../featureModules');
const { userHasBetaFeature } = require('../entitlements/betaFeatures');
const { createWebpageToolsAllowed } = require('./integrationAppPolicy');
const { createRuntimeAppGate } = require('./runtimeAppGate');
const { createExternalToolInjection } = require('./externalToolInjection');
const { createBuildToolHint } = require('./toolHint');
const { createUserAppGate } = require('./userAppGate');
// The tool groups, in the order getIntegrationTools offers them.
const {
    hydrateSessionFromVault, addOAuthProviderTools, addKeyedServiceTools, makeLentProviderCheck,
    addUserCredentialTools, addPersonalServiceTools, addTranscriptionTools,
} = require('./integrationToolGroups');
const {
    addN8nTools, addFirstPartyTools, addNextcloudTools, addAgentCallableAutomations, addStepTools,
} = require('./integrationToolFeatures');

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
    customIntegrationRunner: () => featureModule('integrations/customIntegrationRunner'),
};
const webpageToolsAllowed = createWebpageToolsAllowed({ userHasBetaFeature, lazy });
const resolveRuntimeAppGate = createRuntimeAppGate({ configStore, resolveOrgAllowList, resolveOrgActiveSet, lazy });
const { appendMcpTools, availableMcpServerIds, appendCustomIntegrationTools } = createExternalToolInjection({ lazy });
const buildToolHint = createBuildToolHint({ lazy });
const { getUserPermittedApps, isIntegrationPermittedForUser } = createUserAppGate({ configStore, resolveOrgAllowList, webpageToolsAllowed, lazy });

// The toolsets and the collaborators the tool groups (./integrationToolGroups,
// ./integrationToolFeatures) read, handed in: they sit in the server's large
// import cycle, which those modules stay out of. The lazy ones stay lazy.
// The integration tool arrays and the feature-side collaborators come from
// integrations/coreToolsets.js, looked up by name (core/featureModules.js: core
// may not require a feature) on first use; the core toolsets and lazy
// collaborators are listed here.
const CORE_TOOLSETS = { IMAGE_GEN_TOOLS, VIDEO_GEN_TOOLS, ELEVENLABS_TOOLS };
const CORE_GROUP_DEPS = {
    configStore, hasPermission,
    googleSessionHydration: () => require('../../auth/googleSessionHydration'),
    microsoftSessionHydration: () => require('../../auth/microsoftSessionHydration'),
    pwtRunner: () => featureModule('services/pwtRunner'),
    agentCallableTools: () => featureModule('automation/agentCallableTools'),
    connectionResolution: () => require('./connectionResolution'),
    integrationConnectionStore: () => require('../../stores/integrationConnectionStore'),
    automationCredentialStore: () => require('../../stores/automationCredentialStore'),
    entitlements: () => require('../entitlements/entitlements'),
    datatableTools: () => require('../tools/datatableTools'),
    userStore: () => require('../../stores/userStore'),
    ncScope: () => require('./ncScope'),
    toolPolicy: () => require('../agentRuntime/toolPolicy'),
};
/** The toolsets and group collaborators, feature side included (read per call, so a test's stubs are seen). */
function featureToolsets() {
    const { TOOLSETS, GROUP_DEPS } = featureModule('integrations/coreToolsets');
    return { T: { ...TOOLSETS, ...CORE_TOOLSETS }, D: { ...GROUP_DEPS, ...CORE_GROUP_DEPS } };
}

// The app-id lists (ORG_EXEMPT_APPS, AUTO_ENABLED_APPS) and webpageToolsAllowed
// live in integrationAppPolicy.js; the gate that folds them with the org,
// group and entitlement layers in runtimeAppGate.js; MCP / custom-integration
// injection in externalToolInjection.js; the system-prompt hint in
// toolHint.js; the design-time gate in userAppGate.js.

/**
 * Build the list of integration tools available for the current user.
 * 
 * @param {{ userId: string, session?: Partial<Express.Session>, isAdmin?: boolean,
 *   agentConfig?: import('./integrationToolFeatures').AgentConfig | null, agentId?: string | null,
 *   automationStep?: boolean,
 *   connectionPolicy?: { ownerUserId?: string, resourceType?: string | null, resourceId?: string | null } | null,
 *   enabledAppsOverride?: string[]|null, extraEnabledApps?: string[]|null }} options `userId`: Current
 *   user ID; `session`: Express session (for OAuth tokens); `isAdmin`: Whether user is admin;
 *   `agentConfig`: The agent's runtime config (its per-action grants narrow the toolbelt);
 *   `automationStep`: An automation step asks: strict app gating, no skill-scoped extras;
 *   `connectionPolicy`: Connection lending on a shared resource run; `enabledAppsOverride`: Stands in
 *   for the user's workspace-wide enabled-apps preference for this call. Used by a cowork item that
 *   carries its own, narrower list: the run may only touch what that item allows, regardless of what
 *   the user has on elsewhere. Goes through the SAME gate as the stored preference, so the
 *   AUTO_ENABLED_APPS carve-out and every entitlement/credential check below still apply — it narrows
 *   the user layer, it can never widen anything; `extraEnabledApps`: App ids allowed by an active skill
 *   (skill-scoped enablement). INVARIANT: this bypasses ONLY the per-user enabled-apps preference — it
 *   must never widen org entitlements or skip credential/session checks
 * @returns {Promise<{ tools: import('../agentRuntime/chatStream/turnState').ToolDef[], n8nOrgId: string | null }>}
 */
async function getIntegrationTools({ userId, session, isAdmin, agentConfig, agentId = null, automationStep = false, connectionPolicy = null, extraEnabledApps = null, enabledAppsOverride = null }) {
    const tools = [];
    const { T: TOOLSETS, D: GROUP_DEPS } = featureToolsets();

    const { userSimpleMode, userOrgId, resolvedUserGroupIds, entSnapshot, effectiveIntegrations, isAppOn } =
        await resolveRuntimeAppGate({ userId, session, isAdmin, extraEnabledApps, enabledAppsOverride });

    const _isToolGranted = perActionGrantFilter(agentConfig);
    const addTools = (toolArray) => {
        for (const tool of toolArray) {
            if (_isToolGranted && !_isToolGranted(tool)) continue;
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    };
    // The run context every tool group reads (./integrationToolGroups,
    // ./integrationToolFeatures).
    const c = {
        userId, session, isAdmin, agentConfig, automationStep, userSimpleMode, userOrgId, entSnapshot,
        isAppOn, addTools, T: TOOLSETS, D: GROUP_DEPS,
    };

    await hydrateSessionFromVault({ session, D: GROUP_DEPS });
    await addOAuthProviderTools(c);
    await addKeyedServiceTools(c);
    c.isLentProvider = makeLentProviderCheck({ userId, connectionPolicy, D: GROUP_DEPS });
    await addUserCredentialTools(c);
    const n8nOrgId = await addN8nTools(c);
    await addFirstPartyTools(c);
    await addPersonalServiceTools(c);
    await addNextcloudTools(c);
    await addTranscriptionTools(c);

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
        addTools(TOOLSETS.WEBPAGE_AUTOMATION_TOOLS);
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

    await addAgentCallableAutomations(tools, { userId, userOrgId, agentId, agentConfig, D: GROUP_DEPS });
    await addStepTools(tools, { userId, userOrgId, D: GROUP_DEPS });

    return { tools, n8nOrgId };
}

/**
 * Per-action grants (agent-only). `agentConfig.tools` narrows an app the
 * agent already has ON down to named actions. It lives NEXT TO
 * enabledIntegrations, which stays the app-level switch — this only ever
 * SUBTRACTS from what the gates already allowed, and an agent (or a caller)
 * without a `tools` map keeps exactly today's toolbelt, which is why there is
 * no migration.
 *
 * Applied inside addTools rather than at each call site so it cannot be
 * forgotten on the ~80th `if (isAppOn(x)) addTools(X_TOOLS)` line. Returns
 * the filter, or null when there is nothing to enforce.
 */
function perActionGrantFilter(agentConfig) {
    try {
        const _policy = require('../agentRuntime/toolPolicy');
        const _grantsConfig = _policy.toolsConfigOf(agentConfig);
        if (_grantsConfig) return (tool) => _policy.isToolAllowed(tool, _grantsConfig);
    } catch (e) {
        // A policy-module failure must not silently WIDEN the toolbelt, but it
        // also must not empty it: without a `tools` map there is nothing to
        // enforce anyway, and with one the safest reachable state is the
        // pre-grant behaviour plus a loud line in the log.
        log.warn('[IntegrationTools] tool policy unavailable — per-action grants not applied:', /** @type {Error} */ (e).message);
    }
    return null;
}

module.exports = { getIntegrationTools, buildToolHint, getUserPermittedApps, isIntegrationPermittedForUser, webpageToolsAllowed, appendMcpTools, appendCustomIntegrationTools, availableMcpServerIds };
