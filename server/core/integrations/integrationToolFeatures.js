/**
 * The org- and feature-gated tool groups of getIntegrationTools
 * (./integrationTools.js): n8n, the first-party tools (regex generator,
 * notebooks, presentations, Word, memory, automation evolution, KB search,
 * datatables, KB ingest), Nextcloud, and the agent-callable automations and
 * reusable Steps.
 *
 * Every function takes the run context `c` built in getIntegrationTools.
 * The toolsets (`c.T`, e.g. `T.GMAIL_TOOLS`) and every collaborator in the
 * server's large import cycle (`c.D`: the config store and lazy getters for
 * the rest) are handed in by ./integrationTools, which requires them, so this
 * module stays out of that cycle. The ORDER of the calls is the order the
 * model sees the tools in, and the order of the configStore lookups is pinned
 * by integrationTools.characterisation.test.js.
 */

const log = require('../../telemetry/log');

/** Each Nextcloud family's app id and toolset name, in the order they are offered. */
const NEXTCLOUD_FAMILIES = [
    ['nextcloud', 'NEXTCLOUD_TOOLS'],
    ['nextcloud-calendar', 'NEXTCLOUD_CALENDAR_TOOLS'],
    ['nextcloud-contacts', 'NEXTCLOUD_CONTACTS_TOOLS'],
    ['nextcloud-deck', 'NEXTCLOUD_DECK_TOOLS'],
    ['nextcloud-notifications', 'NEXTCLOUD_NOTIFICATIONS_TOOLS'],
    ['nextcloud-talk', 'NEXTCLOUD_TALK_TOOLS'],
    ['nextcloud-tasks', 'NEXTCLOUD_TASKS_TOOLS'],
    ['nextcloud-notes', 'NEXTCLOUD_NOTES_TOOLS'],
    ['nextcloud-mail', 'NEXTCLOUD_MAIL_TOOLS'],
    ['nextcloud-activity', 'NEXTCLOUD_ACTIVITY_TOOLS'],
    ['nextcloud-tables', 'NEXTCLOUD_TABLES_TOOLS'],
    ['nextcloud-forms', 'NEXTCLOUD_FORMS_TOOLS'],
    ['nextcloud-teams', 'NEXTCLOUD_TEAMS_TOOLS'],
    ['nextcloud-status', 'NEXTCLOUD_STATUS_TOOLS'],
];

/**
 * N8N workflows — org-level config. Read/run tools are implicit for every
 * member once the org has n8n configured (umbrella 'n8n' toggle, handled by
 * AUTO_ENABLED_APPS so legacy users with stale enabledApps lists don't lose
 * access). Only the write-bucket is permission-gated via
 * modify_n8n_workflows. Resolves to the n8n org id (null when not resolved).
 */
async function addN8nTools({ userId, session, userSimpleMode, userOrgId, isAppOn, addTools, D }) {
    let n8nOrgId = null;
    try {
        if (!userSimpleMode && userOrgId) {
            n8nOrgId = userOrgId;
            const n8nUrl = await D.configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await D.configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            if (n8nUrl && n8nKey && isAppOn('n8n')) {
                const canModify = await D.hasPermission(userId, 'modify_n8n_workflows', session);

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
                const n8nTools = await D.buildN8nTools(n8nOrgId);
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
                addTools(D.N8N_WORKFLOW_TOOLS.filter(
                    t => !(D.getN8nToolPermission(t.function.name) === 'modify_n8n_workflows' && !canModify),
                ));
            }
        }
    } catch (e) {
        log.error('[IntegrationTools] n8n tool injection error:', e.message);
    }
    return n8nOrgId;
}

/** The first-party tools: regex generator, notebooks, presentations, Word, memory, automation evolution, KB, datatables. */
async function addFirstPartyTools({ userId, session, isAdmin, agentConfig, automationStep, userSimpleMode, entSnapshot, isAppOn, addTools, T, D }) {
    // Regex Generator — admin only
    if (!userSimpleMode && isAdmin) {
        addTools(T.REGEX_GENERATOR_TOOLS);
    }

    // Workspace/Notebook — check feature flag (disabled from admin panel = no tools)
    const notebooksFeatureEnabled = (await D.configStore.getConfig('feature_notebooks_enabled')) !== false;
    if (!userSimpleMode && notebooksFeatureEnabled) {
        // BFSF-207: notebook tools mirror the HTTP surface gates — `notebooks`
        // capability via the unified resolver (same as requireCapability on
        // /api/notebooks + /api/ai/chat/notebook) AND the use_notebooks RBAC
        // permission (same as routes/notebooks.js). Fail closed on a missing/
        // degraded snapshot (matches the MCP fail-closed posture).
        let notebooksEntitled = false;
        try {
            const entitlements = D.entitlements();
            notebooksEntitled = !!(entSnapshot && !entSnapshot.degraded && entitlements.snapshotHas(entSnapshot, 'notebooks'));
        } catch (_) { notebooksEntitled = false; }
        if (notebooksEntitled && await D.hasPermission(userId, 'use_notebooks', session)) {
            addTools(T.WORKSPACE_TOOLS);
        }
    }

    // Presentations — a first-party artefact tool like create_document: builds
    // a real .pptx in the org's house style and hands back a download link.
    // No credentials, no org toggle; the simple mode is the only switch.
    if (!userSimpleMode) {
        addTools(D.presentationTools().PRESENTATION_TOOLS);
        // Word documents — the same footing: a real .docx in the org's Word
        // house style, kept in storage (or Nextcloud) behind a download link.
        addTools(D.wordDocumentTools().WORD_DOCUMENT_TOOLS);
    }

    // Personal memory — the user's own user_memories, read and written through
    // two tools. First-party and org-exempt; the per-user enabled-apps
    // preference is the only switch (memory itself is governed by the memory
    // settings, which the tools honour by reading through memoryStore).
    if (isAppOn('memory')) {
        addTools(D.memoryTools().MEMORY_TOOLS);
    }
    // Automation evolution — automation steps only (never chat): an automation proposes
    // and, after approval, applies changes to its OWN definition.
    if (automationStep && isAppOn('automation-evolution')) {
        addTools(D.automationEvolutionTools().AUTOMATION_EVOLUTION_TOOLS);
    }

    // KB Search — available when agent has knowledge bases configured
    // This lets agents explicitly search KB with custom queries (e.g., after reading an email)
    if (agentConfig?.knowledge_base_ids?.length > 0) {
        addTools(T.KB_SEARCH_TOOLS);
    }

    // Datatable as knowledge — `datatable_query`, read-only and LIVE (A1c).
    // Built HERE rather than in getAgentTools because the definition depends on
    // the person ASKING: every granted table is resolved as them and the ones
    // they may not read are left out, so no table name reaches a model through
    // a tool description the asker could not have opened themselves.
    // Costs nothing for an agent whose owner granted no table — the grants map
    // is checked before any database work.
    try {
        const { buildDatatableTools } = D.datatableTools();
        addTools(await buildDatatableTools({ userId, agentConfig }));
    } catch (e) {
        // One tool, not the toolbelt: an exception escaping here is caught by
        // toolStackAssembly, which drops EVERY integration tool for the turn.
        log.warn('[IntegrationTools] datatable_query unavailable:', e.message);
    }

    // KB Ingest — automation-only WRITE tool (Support Studio "solved tickets → KB"
    // template). Never surfaced to chat agents (automationStep gate) and only to
    // holders of the org-level support_inbox permission.
    if (automationStep && isAppOn('kb-ingest') && await D.hasPermission(userId, 'support_inbox', session)) {
        addTools(T.KB_INGEST_TOOLS);
    }
}

/**
 * Nextcloud — OAuth path (parity with Google/Microsoft) with app-password
 * fallback for users not logged in via Nextcloud OAuth. Once a Nextcloud
 * connection (either mode) is established, every sub-app (files, calendar,
 * contacts, Deck, notifications) gates on its own per-app toggle so admins
 * can disable individual surfaces.
 */
async function addNextcloudTools({ userId, session, userOrgId, isAppOn, addTools, T, D }) {
    try {
        const oauthCfg = (await D.configStore.getConfig('oauth')) || {};
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
                const ncClient = D.nextcloudClient();
                isConnectorUser = !!(await ncClient.resolveNcBinding(session, userId));
            } catch (_) { /* store unavailable — fall through to URL/app-password */ }
        }
        // A user who saved their own app password may also carry a per-user
        // Nextcloud URL (Settings → Connections), which makes NC reachable even
        // when the org-wide oauth.nextcloudUrl is unset. Look it up once so it
        // can both open the gate and signal the connection.
        const userStoreLocal = D.userStore();
        const ncCreds = isConnectorUser ? null : await userStoreLocal.getAppPassword(userId);
        const hasNcUrl = !!(oauthCfg.nextcloudUrl || ncCreds?.url);
        if (!(hasNcUrl || isConnectorUser)) return;
        const nextcloudConnected = isConnectorUser
            || !!(session?.oauthProvider === 'nextcloud' && session?.accessToken)
            || !!(ncCreds?.username && ncCreds?.password);
        if (!nextcloudConnected) return;
        // Per-user scope, Layer 1 (UX): families the user switched OFF are
        // not even offered to the model. Resolved AFTER isAppOn's
        // entitlement/org gates and only ever subtracts from them — the
        // authoritative enforcement (incl. the org ceiling and per-resource
        // selections) lives in toolDispatcher via ncScopeGuard, so a miss here
        // can only cost a denied call, never grant one.
        let scopeOn = () => true;
        try {
            const { resolveNcScope } = D.ncScope();
            // orgId matters: the org ceiling is where the admin's own
            // Nextcloud toggles live. Without it a family the org turned off
            // would still be offered to the model, which would call it and be
            // refused by the guard — correct, but a wasted turn and a
            // confusing refusal.
            const ncScope = await resolveNcScope({ userId, orgId: userOrgId });
            scopeOn = (id) => ncScope[id]?.mode !== 'off';
        } catch (_) { /* Layer 2 still enforces — keep offering */ }
        for (const [appId, toolset] of NEXTCLOUD_FAMILIES) {
            if (scopeOn(appId) && isAppOn(appId)) addTools(T[toolset]);
        }
    } catch (e) { /* ignore — credentials missing or store unavailable */ }
}

/** The org id the `automations` capability is resolved against. */
function capabilityOrgId(userOrgId) {
    return (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
}

/**
 * Agent-callable automations (trigger.kind === 'agent_call'). They are
 * reachable ONLY through the agent they are bound to
 * (automation_agent_bindings, automation/agentBinding.js): each active one
 * bound to `agentId` becomes a function tool the model can call. No agent,
 * no tool: direct chat, Cowork / AI tasks, voice without an agent and the
 * /mcp endpoint pass no `agentId` and are offered none. Gated by the same
 * 'automations' capability the scheduler checks, fail closed if the org
 * lacks it or the lookup throws, so we never surface automations on
 * installs without automations.
 *
 * The agent's own grant list (`config.tools.automations`) still NARROWS the
 * bound set for a CURATED agent: bound AND granted. It can only narrow; a
 * grant for an automation that is not bound to this agent offers nothing,
 * so a list written before the bindings existed cannot widen anything.
 *
 * The presence of the key is the choice, not its content: an empty section
 * means "I switched all automations off". Treating empty as uncurated would
 * hand back the whole bound set, the opposite of what the owner clicked, so
 * the normalisation keeps an empty section on purpose (see
 * toolPolicy.normaliseToolsConfig).
 */
async function addAgentCallableAutomations(tools, { userId, userOrgId, agentId, agentConfig, D }) {
    const _plainObjectLike = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const _automationGrants = (() => {
        try {
            const p = D.toolPolicy();
            return p.automationGrantsOf(p.toolsConfigOf(agentConfig));
        } catch (_) { return null; }        // policy unreadable — decided below
    })();
    const _curatedAutomations = !!(agentConfig && _plainObjectLike(agentConfig.tools)
        && Object.prototype.hasOwnProperty.call(agentConfig.tools, 'automations'));
    try {
        if (!agentId) return;   // nothing to look up: no agent, no automation tools
        if (_curatedAutomations && !_automationGrants) {
            log.warn('[IntegrationTools] Automation grants unreadable — offering no agent-callable automations');
            return;
        }
        const { hasCapability } = D.entitlements();
        if (await hasCapability('automations', { userId, orgId: capabilityOrgId(userOrgId) })) {
            const { getAgentCallableTools } = D.agentCallableTools();
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
        log.warn('[IntegrationTools] Failed to load agent-callable automations:', e.message);
    }
}

/**
 * Reusable Steps (kind='block') the user published and marked "available in
 * chat". Owner-only in v1 (mirrors agent_call), so the Step runs under the
 * caller's own identity. Same 'automations' capability gate.
 */
async function addStepTools(tools, { userId, userOrgId, D }) {
    try {
        const { hasCapability } = D.entitlements();
        if (await hasCapability('automations', { userId, orgId: capabilityOrgId(userOrgId) })) {
            const { getStepToolsForUser } = D.agentCallableTools();
            const stepTools = await getStepToolsForUser(userId);
            for (const t of stepTools) {
                if (!tools.find(x => x?.function?.name === t?.function?.name)) tools.push(t);
            }
        }
    } catch (e) {
        log.warn('[IntegrationTools] Failed to load Step tools:', e.message);
    }
}

module.exports = {
    addN8nTools, addFirstPartyTools, addNextcloudTools, addAgentCallableAutomations, addStepTools,
};
