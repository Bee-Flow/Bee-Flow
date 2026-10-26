// @typecheck noImplicitAny
/**
 * The integration tool families, registered with core's tool dispatcher.
 *
 * core/tools/toolDispatcher.js routes a tool call through the registry in
 * core/tools/toolFamilyRegistry.js and requires no integration itself (CORE
 * must not require a FEATURE, server/ARCHITECTURE.md). This module is the
 * feature side of that contract: requiring it registers every family below.
 * The server requires it at boot (index.js); a test that runs the REAL
 * dispatcher against an integration tool requires it too.
 *
 * `order` reproduces the sequence of the dispatcher's former if-chain, with
 * core's own families (builtinToolFamilies.js) in between. It matters where
 * predicates overlap — every n8n workflow tool is also an n8n_* tool, so the
 * workflow family (with its permission check) must come first — and
 * toolFamilies.test.js pins the whole sequence.
 */

const { registerToolFamily } = require('../core/tools/toolFamilyRegistry');
const { hasPermission } = require('../auth/permissions');
const { isGmailTool, executeGmailTool } = require('./gmailTools');
const { isCalendarTool, executeCalendarTool } = require('./calendarTools');
const { isDriveTool, executeDriveTool } = require('./driveTools');
const { isDocsTool, executeDocsTool } = require('./docsTools');
const { isSheetsTool, executeSheetsTool } = require('./sheetsTools');
const { isSlidesTool, executeSlidesTool } = require('./slidesTools');
const { isContactsTool, executeContactsTool } = require('./contactsTools');
const { isKeepTool, executeKeepTool } = require('./keepTools');
const { isGoogleGroupsTool, executeGoogleGroupsTool } = require('./googleGroupsTools');
const { isFirefliesTool, executeFirefliesTool } = require('./firefliesTools');
const { isYouTrackTool, executeYouTrackTool } = require('./youtrackTools');
const { isSignRequestTool, executeSignRequestTool } = require('./signrequestTools');
const { isGammaTool, executeGammaTool } = require('./gammaTools');
const { isAfasTool, executeAfasTool } = require('./afasTools');
const { isNmbrsTool, executeNmbrsTool } = require('./nmbrsTools');
const { isVplanTool, executeVplanTool } = require('./vplanTools');
const { isScalewayBillingTool, executeScalewayBillingTool } = require('./scalewayBillingTools');
const { isN8nTool, executeN8nTool } = require('./n8nTools');
const { isN8nWorkflowTool, executeN8nWorkflowTool, getN8nToolPermission } = require('./n8nWorkflowTools');
const { isAgentSearchTool, executeWebSearch } = require('./agentSearchTools');
const { isReadUrlTool, executeReadUrlTool } = require('./readUrlTools');
const { isBrowseWebTool, executeBrowseWebTool } = require('./browserFetchTools');
const { isRegexGeneratorTool, executeRegexGeneratorTool } = require('./regexGeneratorTools');
const { executeWorkspaceTool } = require('./workspaceTools');
const { isKbSearchTool, executeKbSearchTool } = require('./kbSearchTools');
const { isKbIngestTool, executeKbIngestTool } = require('./kbIngestTools');
const { isMapsTool, executeMapsTool } = require('./mapsTools');
const { isLinkedInTool, executeLinkedInTool } = require('./linkedinTools');
const { isGitHubTool, executeGitHubTool } = require('./githubTools');
const { isOutlookTool, executeOutlookTool } = require('./outlookTools');
const { outlookSessionFor } = require('./outlookSession');
const { isMsCalendarTool, executeMsCalendarTool } = require('./msCalendarTools');
const { isOneDriveTool, executeOneDriveTool } = require('./oneDriveTools');
const { isMsContactsTool, executeMsContactsTool } = require('./msContactsTools');
const { isTranscriptionTool, executeTranscriptionTool } = require('./transcriptionTools');
const { isSupportTool, executeSupportTool } = require('./supportTools');
const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('./webpageAutomationTools');
const { executeNextcloudFamilyTool, executeGuardedNextcloudTool, executeCheckedNextcloudTool, isNextcloudFamilyToolName } = require('./nextcloudToolFamily');

/**
 * The dispatcher's context, with the fields these families read named.
 * @typedef {import('../core/tools/toolFamilyRegistry').ToolContext & {
 *   session?: Express.Session, attachments?: unknown[], supportThreadId?: string,
 *   memoryReadEnabled?: boolean, memoryWriteEnabled?: boolean, testAs?: unknown,
 *   userAuth?: { supportThreadId?: string, supportActionPolicy?: import('./supportTools').ActionPolicy },
 * }} ToolCtx
 */
/** @typedef {Record<string, unknown>} ToolArgs */
/**
 * @typedef {{ name: string, order: number, isTool: (n: string) => boolean,
 *   execute: (n: string, a: ToolArgs, ctx: ToolCtx) => unknown,
 *   parseName?: (n: string) => unknown, executeFamily?: unknown }} IntegrationToolFamily
 */

/**
 * The org a document tool files its output under.
 * @param {ToolCtx} ctx
 */
function documentOrgId({ orgId, session }) {
    return orgId || session?.connectorOrgId || session?.user?.organizationId || null;
}

// ─── Custom Integrations (AI Integration Builder) ──────────────
// Org-scoped cint_<slug>_<tool> calls go straight to the hardened runner
// — org match, status, capability backstop, origin pin, SSRF re-check,
// method gate and secret scrub all live there. First in the walk (order 0)
// so no prefix collision can shadow it.
// `unattended`: context.autoSend is the dispatch-side headless marker —
// the automation runner sets it on LIVE automation runs and webpageApiRuntime
// sets it on backend handler calls. The custom-integration runner refuses
// unattended===true outright for now, and the capability backstop still
// gates every call regardless of path.
//
// The task/cowork runner needs the two halves apart. It must auto-send
// email (nobody is there to approve a draft — see the aiTaskRunner call
// site), but flipping its custom-integration calls to unattended would
// turn working automations into refusals, which is a policy change and not
// this fix's business. So `unattended` can be set explicitly and only
// falls back to autoSend when it wasn't.
/**
 * @param {string} toolName
  * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeCustomIntegration(toolName, toolArgs, context) {
    return await require('./customIntegrationRunner').executeCustomIntegrationTool(toolName, toolArgs, {
        userId: context.userId,
        unattended: context.unattended !== undefined ? !!context.unattended : !!context.autoSend,
    });
}

// ─── Presentations (.pptx) ─────────────────────────────────────
// "Save it in Nextcloud": the same deck through the Nextcloud tool, so
// the file lands where the user asked and the reply gets a webUrl. A
// Nextcloud that is not connected answers with its own error, and the
// deck is then built locally with that error alongside — never lost.
/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeCreatePresentation(toolName, toolArgs, context) {
    const { userId, session } = context;
    const { executePresentationTool } = require('./presentationTools');
    const ncPath = typeof toolArgs?.nextcloudPath === 'string' ? toolArgs.nextcloudPath.trim() : '';
    if (!ncPath) {
        return await executePresentationTool(toolArgs, { userId, session, orgId: documentOrgId(context) });
    }
    const { nextcloudPath, fileName, ...rest } = toolArgs;
    const path = /\.(pptx|odp)$/i.test(ncPath) ? ncPath : `${ncPath.replace(/\/+$/, '')}/${String(fileName || rest.title || 'presentation').replace(/\.pptx$/i, '')}.pptx`;
    // Through the scope guard, exactly like a direct nextcloud_* call.
    const nc = /** @type {{ error?: string } | null} */ (await executeCheckedNextcloudTool('nextcloud_create_presentation', { ...rest, path }, context));
    if (nc && !nc.error) return nc;
    /** @type {{ error?: string, message?: string }} */
    const local = await executePresentationTool(toolArgs, { userId, session, orgId: documentOrgId(context) });
    return { ...local, nextcloud: { error: (nc && nc.error) || 'Nextcloud is not available' }, message: `${local.message || ''} It could NOT be saved to Nextcloud (${(nc && nc.error) || 'not connected'}) — tell the user and give the download link.` };
}

// ─── Word (.docx) and Excel (.xlsx) files ─────────────────────
// Built in-process, then a download link, OneDrive or Nextcloud (after its
// scope guard): integrations/officeFileDelivery.js.
/**
 * @param {string} toolName
  * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeOfficeFile(toolName, toolArgs, context) {
    const { userId, session } = context;
    const { executeOfficeFileTool } = require('./officeFileDelivery');
    return await executeOfficeFileTool(toolName, toolArgs, { userId, session, orgId: documentOrgId(context) });
}

// ─── n8n workflow tools ────────────────────────────────────────
// Read-only n8n tools are implicit for every member of an org with n8n
// configured (umbrella 'n8n' integration toggle gates injection). Only
// the write/execute bucket is permission-gated via modify_n8n_workflows.
// Non-LLM callers (pipelines, schedules) also flow through here, so we
// re-check writes as defense-in-depth vs. the registration-time filter.
/**
 * @param {string} toolName
  * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeN8nWorkflow(toolName, toolArgs, context) {
    const { userId, session, orgId } = context;
    if (userId && getN8nToolPermission(toolName) === 'modify_n8n_workflows') {
        const granted = await hasPermission(userId, 'modify_n8n_workflows', session);
        if (!granted) {
            return { error: 'You do not have permission to modify n8n workflows. Ask your organisation admin to grant the "Modify n8n Workflows" permission.' };
        }
    }
    return await executeN8nWorkflowTool(toolName, toolArgs, orgId);
}

// ─── Interactive browser ───────────────────────────────────────
// `send` streams browser_session_queued/start/frame/action/end events so
// the chat UI shows a live preview while the interactive browser runs.
// userId/orgId let the inner agent resolve the thinking-tier model.
//
// Outside the capture context: this process only talks to the private
// browser container, so its socket would put "local" on a call that
// went to the web. The pages the browser read are recorded instead,
// by host (basis 'browser'); their addresses live in that container.
/**
 * @param {string} toolName
  * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeBrowseWeb(toolName, toolArgs, context) {
    const { send, userId, orgId } = context;
    const { outsideProbe } = require('../core/http/egressCapture');
    const answer = await outsideProbe(() => executeBrowseWebTool(toolName, toolArgs, { send, userId, orgId }));
    recordBrowserPeers(toolArgs?.url, answer);
    return answer;
}

/**
 * The hosts a browse_web call read, as egress peers of the current probe:
 * the start URL, and the "Pages read" list executeBrowseWebTool appends. Only
 * that list is parsed, never the answer above it (page text can say anything).
 * @param {unknown} startUrl
 * @param {unknown} answer
 */
function recordBrowserPeers(startUrl, answer) {
    try {
        const { recordPeer } = require('../core/http/egressCapture');
        /** @type {string[]} */
        const urls = [];
        if (typeof startUrl === 'string' && startUrl.trim()) urls.push(startUrl.trim());
        const text = typeof answer === 'string' ? answer : '';
        const marker = text.lastIndexOf('**Pages read:**');
        if (marker !== -1) {
            for (const m of text.slice(marker).matchAll(/^- (https?:\/\/\S+)$/gm)) urls.push(m[1]);
        }
        for (const u of urls) {
            /** @type {string | null} */
            let host = null;
            try { host = new URL(u).hostname; } catch (_) { continue; }
            recordPeer({ host, ip: null, basis: 'browser', method: 'GET', sentBody: false });
        }
    } catch (err) { fallback('integrations/toolFamilies:recordBrowserPeers', err); /* a missing peer must never fail the browse */ }
}

// ─── Notebook Tools (formerly Workspace) ───────────────────────
const { NOTEBOOK_TOOLS } = require('./notebookToolNames');
const { fallback } = require('../utils/bestEffort');

/**
 * BFSF-207 backstop: notebook tools are entitlement-gated at registration;
 * re-check at dispatch so no other injection path can execute them. Mirrors
 * registration's org resolution (the user's own org — context.orgId is absent
 * in agent chat and may be the LENDER's org under connection lending).
 * Returns the refusal, or null when the user may use notebooks.
 * @param {string} userId
 * @param {Express.Session} session
 */
async function notebookRefusal(userId, session) {
    try {
        const { hasCapability } = require('../core/entitlements/entitlements');
        let resolveOrgId = null;
        try { resolveOrgId = (await require('../stores/userStore').getUser(userId))?.organizationId || null; } catch (_) { fallback('integrations/toolFamilies:notebookRefusal', _); /* user lookup failed, the capability check runs without an org */ }
        const ok = !!userId
            && await hasCapability('notebooks', { userId, orgId: resolveOrgId, session })
            && await hasPermission(userId, 'use_notebooks', session);
        if (!ok) {
            return { error: 'The notebook is not available for this user — the notebooks feature is not included in their plan or has not been enabled for them. Briefly let the user know the notebook is unavailable and continue helping them directly in chat.' };
        }
        return null;
    } catch (_) {
        return { error: 'The notebook is temporarily unavailable. Continue helping the user directly in chat.' };
    }
}

/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeNotebook(toolName, toolArgs, context) {
    const { userId, session } = context;
    const refusal = await notebookRefusal(userId, session);
    if (refusal) return refusal;
    // `userId` is REQUIRED here: the tool's cross-user guard keys off it, and
    // conversationId arrives from the client, so without a caller identity the
    // guard has nothing to compare against and every notebook is reachable.
    return await executeWorkspaceTool(toolName, toolArgs, {
        conversationId: context.conversationId,
        agentId: context.agentId,
        userId,
        session,
    });
}

// ─── Memory ────────────────────────────────────────────────────
/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeMemory(toolName, toolArgs, context) {
    const { userId, orgId, agentId, session } = context;
    return await require('./memoryTools').executeMemoryTool(toolName, toolArgs, {
        userId, orgId, agentId, session,
        // Provenance: the memory_remember tool stores source_conversation_id from this.
        conversationId: context.conversationId || null,
        // Agent chat puts the per-chat flags on the context; direct chat only has the request.
        memoryReadEnabled: context.memoryReadEnabled ?? context.req?.body?.memoryReadEnabled,
        memoryWriteEnabled: context.memoryWriteEnabled ?? context.req?.body?.memoryWriteEnabled,
    });
}

// ─── KB Search ─────────────────────────────────────────────────
// `testAs` HAS to be forwarded, and this line is the whole reason the
// simulation is not a false green. `toolRoundExecutor` puts it on the
// dispatch context and `kbSearchTools` reads `context.testAs` off the
// one it is handed here — but this builds a FRESH object, so a key that
// is not named here simply does not exist downstream. Without it the tool
// filters as the plain asker: the auto-injected knowledge is narrowed to
// the simulated group while the model fetches back exactly what the
// preview just hid, one tool call later.
//
// It is not an identity and it never widens anything — `visibleKbIdsFor`
// only removes bases from a list the real person may already read.
/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeKbSearch(toolName, toolArgs, context) {
    return await executeKbSearchTool(toolName, toolArgs, {
        userId: context.userId,
        agentId: context.agentId,
        conversationId: context.conversationId,
        testAs: context.testAs || null,
    });
}

// ─── Outlook ───────────────────────────────────────────────────
// A Google (or Nextcloud) session may carry Outlook tools when the user
// connected Microsoft 365 separately (getIntegrationTools adds them off
// the vault credential). Graph must then get a Microsoft-only shim,
// never this session's foreign token; a Microsoft session passes
// through unchanged. `autoSend` follows gmail_compose exactly.
/**
 * @param {string} toolName
  * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeOutlook(toolName, toolArgs, context) {
    const msSession = await outlookSessionFor(toolArgs, context);
    return await executeOutlookTool(toolName, toolArgs, msSession, { autoSend: !!context.autoSend });
}

/**
 * Families whose executor takes (toolName, toolArgs, userId).
 * @param {(n: string, a: ToolArgs, userId: string) => unknown} execute
 * @returns {IntegrationToolFamily['execute']}
 */
const byUser = execute => (name, args, ctx) => execute(name, args, ctx.userId);
/**
 * Families whose executor takes (toolName, toolArgs, session).
 * @param {(n: string, a: ToolArgs, session: Express.Session) => unknown} execute
 * @returns {IntegrationToolFamily['execute']}
 */
const bySession = execute => (name, args, ctx) => execute(name, args, ctx.session);

/** @type {IntegrationToolFamily[]} */
const INTEGRATION_TOOL_FAMILIES = [
    // `parseName` gives core's progressive disclosure the cint_<slug>_<tool> grammar.
    { name: 'custom_integration', order: 0, isTool: (/** @type {string} */ n) => require('./customIntegrationRunner').isCustomIntegrationTool(n), execute: executeCustomIntegration, parseName: (/** @type {string} */ n) => require('./customIntegrationRunner').parsePrefixedName(n) },
    { name: 'create_presentation', order: 40, isTool: (/** @type {string} */ n) => n === 'create_presentation', execute: executeCreatePresentation },
    { name: 'create_word_document', order: 50, isTool: (/** @type {string} */ n) => n === 'create_word_document' || n === 'create_spreadsheet', execute: executeOfficeFile },
    { name: 'fireflies', order: 100, isTool: isFirefliesTool, execute: byUser(executeFirefliesTool) },
    { name: 'regex_generator', order: 110, isTool: isRegexGeneratorTool, execute: (n, a) => executeRegexGeneratorTool(n, a) },
    { name: 'youtrack', order: 120, isTool: isYouTrackTool, execute: byUser(executeYouTrackTool) },
    { name: 'signrequest', order: 130, isTool: isSignRequestTool, execute: byUser(executeSignRequestTool) },
    { name: 'gamma', order: 140, isTool: isGammaTool, execute: byUser(executeGammaTool) },
    { name: 'afas', order: 150, isTool: isAfasTool, execute: byUser(executeAfasTool) },
    { name: 'nmbrs', order: 160, isTool: isNmbrsTool, execute: (n, a, ctx) => executeNmbrsTool(n, a, ctx.userId, { orgId: ctx.orgId }) },
    { name: 'vplan', order: 170, isTool: isVplanTool, execute: byUser(executeVplanTool) },
    // The run scope lets scaleway_download_invoice keep the PDF for this
    // automation run and hand on a generated_file handle.
    { name: 'scaleway_billing', order: 180, isTool: isScalewayBillingTool, execute: (n, a, ctx) => executeScalewayBillingTool(n, a, ctx.userId, { automationId: ctx.automationId || null, runScope: ctx.runScope || null }) },
    // Lazily required: withingsTools pulls in automationAuth (and through it the
    // credential vault), which nothing else on this hot path needs.
    { name: 'withings', order: 190, isTool: n => require('./withingsTools').isWithingsTool(n), execute: (n, a, ctx) => require('./withingsTools').executeWithingsTool(n, a, ctx.userId) },
    // `autoSend` is opt-in per-call: only the automation runner sets it (no
    // user is present to confirm a draft). Direct chat / agent chat leave it
    // false so the email_draft → user approves → send flow stays.
    { name: 'gmail', order: 200, isTool: isGmailTool, execute: (n, a, ctx) => executeGmailTool(n, a, ctx.session, { autoSend: !!ctx.autoSend }) },
    // BFSF-254: pass the requester's IANA timezone through so drafts and the
    // approved create/update carry it — Google rejects bare local dateTimes
    // ("Missing time zone definition for start time").
    { name: 'google_calendar', order: 210, isTool: isCalendarTool, execute: (n, a, ctx) => executeCalendarTool(n, a, ctx.session, { timezone: ctx.timezone || null }) },
    { name: 'google_docs', order: 220, isTool: isDocsTool, execute: bySession(executeDocsTool) },
    { name: 'google_sheets', order: 230, isTool: isSheetsTool, execute: bySession(executeSheetsTool) },
    { name: 'google_slides', order: 240, isTool: isSlidesTool, execute: bySession(executeSlidesTool) },
    { name: 'google_drive', order: 250, isTool: isDriveTool, execute: (n, a, ctx) => executeDriveTool(n, a, ctx.session, { runScope: ctx.runScope || null }) },
    { name: 'google_contacts', order: 260, isTool: isContactsTool, execute: bySession(executeContactsTool) },
    { name: 'google_keep', order: 270, isTool: isKeepTool, execute: bySession(executeKeepTool) },
    { name: 'google_groups', order: 280, isTool: isGoogleGroupsTool, execute: bySession(executeGoogleGroupsTool) },
    // Before 'n8n': every workflow tool is an n8n_* name too.
    { name: 'n8n_workflow', order: 290, isTool: isN8nWorkflowTool, execute: executeN8nWorkflow },
    // Webhook-trigger tools are implicit for every member once the org has n8n
    // configured — gated only by the umbrella 'n8n' integration toggle at
    // injection time (see core/integrations/integrationTools.js).
    { name: 'n8n', order: 300, isTool: isN8nTool, execute: (n, a, ctx) => executeN8nTool(n, a, ctx.orgId, ctx.attachments) },
    // Routed by the admin-configured search provider (bing / node-search /
    // agent-search service, with node-search fallback for CPU-only deploys).
    { name: 'agent_search', order: 310, isTool: isAgentSearchTool, execute: (n, a) => executeWebSearch(n, a) },
    // Plain GET through the SSRF-guarded fetch; the egress probe records the host.
    { name: 'read_url', order: 320, isTool: isReadUrlTool, execute: (n, a) => executeReadUrlTool(n, a) },
    { name: 'browse_web', order: 330, isTool: isBrowseWebTool, execute: executeBrowseWeb },
    { name: 'notebook', order: 420, isTool: n => NOTEBOOK_TOOLS.has(n), execute: executeNotebook },
    { name: 'memory', order: 430, isTool: n => require('./memoryTools').isMemoryTool(n), execute: executeMemory },
    // Self-scoped: context.automationId is set by the automation runner only.
    { name: 'automation_evolution', order: 440, isTool: n => require('./automationEvolutionTools').isAutomationEvolutionTool(n), execute: (n, a, ctx) => require('./automationEvolutionTools').executeAutomationEvolutionTool(n, a, { userId: ctx.userId, orgId: ctx.orgId, automationId: ctx.automationId || null, autoSend: ctx.autoSend === true }) },
    { name: 'kb_search', order: 450, isTool: isKbSearchTool, execute: executeKbSearch },
    // Automation-only WRITE (Support Studio template).
    { name: 'kb_ingest', order: 470, isTool: isKbIngestTool, execute: (n, a, ctx) => executeKbIngestTool(n, a, { orgId: ctx.orgId, userId: ctx.userId }) },
    { name: 'maps', order: 480, isTool: isMapsTool, execute: (n, a) => executeMapsTool(n, a) },
    { name: 'linkedin', order: 490, isTool: isLinkedInTool, execute: bySession(executeLinkedInTool) },
    { name: 'github', order: 500, isTool: isGitHubTool, execute: byUser(executeGitHubTool) },
    { name: 'nextcloud', order: 510, isTool: isNextcloudFamilyToolName, execute: executeGuardedNextcloudTool, executeFamily: executeNextcloudFamilyTool },
    { name: 'support', order: 520, isTool: isSupportTool, execute: (n, a, ctx) => executeSupportTool(n, a, { userId: ctx.userId, session: ctx.session, userAuth: ctx.userAuth, supportThreadId: ctx.supportThreadId, supportActionPolicy: ctx.userAuth?.supportActionPolicy || null }) },
    { name: 'webpage_automation', order: 530, isTool: isWebpageAutomationTool, execute: (n, a, ctx) => executeWebpageAutomationTool(n, a, { userId: ctx.userId, organizationId: ctx.orgId, userGroupIds: ctx.userGroupIds || [], userOrgIds: ctx.userOrgIds || (ctx.orgId ? [ctx.orgId] : []) }) },
    { name: 'outlook', order: 540, isTool: isOutlookTool, execute: executeOutlook },
    { name: 'ms_calendar', order: 550, isTool: isMsCalendarTool, execute: bySession(executeMsCalendarTool) },
    { name: 'onedrive', order: 560, isTool: isOneDriveTool, execute: bySession(executeOneDriveTool) },
    { name: 'ms_contacts', order: 570, isTool: isMsContactsTool, execute: bySession(executeMsContactsTool) },
    { name: 'transcription', order: 580, isTool: isTranscriptionTool, execute: (n, a, ctx) => executeTranscriptionTool(n, a, { userId: ctx.userId, session: ctx.session, attachments: ctx.attachments, req: ctx.req }) },
];

function registerIntegrationToolFamilies() {
    for (const family of INTEGRATION_TOOL_FAMILIES) registerToolFamily(family);
}

registerIntegrationToolFamilies();

module.exports = { INTEGRATION_TOOL_FAMILIES, registerIntegrationToolFamilies, recordBrowserPeers };
