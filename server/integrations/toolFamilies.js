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
 *
 * Only the core's families are listed here. A first-party module's families
 * (Google, Microsoft, Nextcloud, the SaaS and ERP integrations, notebooks,
 * support, ...) are in its firstParty/<id>.register.js, each with the order
 * number it had in this list, contributed to the channel
 * 'integrations/toolFamilies' (modules/firstParty/registrationChannels.js)
 * that this file opens once its own families are in: requiring it still
 * registers every family of every module that is present.
 */
const { registerToolFamily } = require('../core/tools/toolFamilyRegistry');
const { isAgentSearchTool, executeWebSearch } = require('./agentSearchTools');
const { isReadUrlTool, executeReadUrlTool } = require('./readUrlTools');
const { isBrowseWebTool, executeBrowseWebTool } = require('./browserFetchTools');
const { isRegexGeneratorTool, executeRegexGeneratorTool } = require('./regexGeneratorTools');
const { isKbSearchTool, executeKbSearchTool } = require('./kbSearchTools');
const { agentToolLog } = require('../core/kb/queryLog/hook.mts');
const { isKbIngestTool, executeKbIngestTool } = require('./kbIngestTools');
const { fallback } = require('../utils/bestEffort');

/**
 * The dispatcher's context, with the fields these families read named.
 * @typedef {import('../core/tools/toolFamilyRegistry').ToolContext & {
 *   session?: Express.Session, attachments?: unknown[], queryLog?: { carrier: object, channel: 'agent_chat' | 'agent_chat_sync' } | null, supportThreadId?: string,
 *   memoryReadEnabled?: boolean, memoryWriteEnabled?: boolean, testAs?: unknown, askerUserId?: string, mailTrigger?: import('./mailReplyGuard').MailTriggerContext | null,
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

/**
 * The Nextcloud family's executor behind its scope guard, or null when the
 * int_nextcloud module is absent (core mode): the deck is then built locally
 * and the answer says Nextcloud is not available. An optional lookup until
 * the Nextcloud side has a port of its own.
 * @returns {((name: string, args: ToolArgs, ctx: ToolCtx) => Promise<unknown>) | null}
 */
function checkedNextcloudTool() {
    try {
        return require('./nextcloudToolFamily').executeCheckedNextcloudTool;
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'MODULE_NOT_FOUND') throw err;
        return null;
    }
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
    const executeChecked = checkedNextcloudTool();
    const nc = /** @type {{ error?: string } | null} */ (executeChecked ? await executeChecked('nextcloud_create_presentation', { ...rest, path }, context) : null);
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

// ─── Memory ────────────────────────────────────────────────────
/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeMemory(toolName, toolArgs, context) {
    const { orgId, agentId, session } = context;
    return await require('./memoryTools').executeMemoryTool(toolName, toolArgs, {
        userId: context.askerUserId || context.userId, orgId, agentId, session, // the asker's memories, never an acting identity's
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
        userId: context.userId, agentId: context.agentId, conversationId: context.conversationId,
        testAs: context.testAs || null,
        ...agentToolLog(context), // KB query log: registers the search on the turn's carrier
    });
}

/** @type {IntegrationToolFamily[]} */
const INTEGRATION_TOOL_FAMILIES = [
    { name: 'create_presentation', order: 40, isTool: (/** @type {string} */ n) => n === 'create_presentation', execute: executeCreatePresentation },
    { name: 'create_word_document', order: 50, isTool: (/** @type {string} */ n) => n === 'create_word_document' || n === 'create_spreadsheet', execute: executeOfficeFile },
    { name: 'regex_generator', order: 110, isTool: isRegexGeneratorTool, execute: (n, a) => executeRegexGeneratorTool(n, a) },
    // Routed by the admin-configured search provider (bing / node-search /
    // agent-search service, with node-search fallback for CPU-only deploys).
    { name: 'agent_search', order: 310, isTool: isAgentSearchTool, execute: (n, a) => executeWebSearch(n, a) },
    // Plain GET through the SSRF-guarded fetch; the egress probe records the host.
    { name: 'read_url', order: 320, isTool: isReadUrlTool, execute: (n, a) => executeReadUrlTool(n, a) },
    { name: 'browse_web', order: 330, isTool: isBrowseWebTool, execute: executeBrowseWeb },
    { name: 'memory', order: 430, isTool: n => require('./memoryTools').isMemoryTool(n), execute: executeMemory },
    { name: 'kb_search', order: 450, isTool: isKbSearchTool, execute: executeKbSearch },
    // Automation-only WRITE (Support Studio template). sanctions: local screening, the executor re-checks the licence.
    { name: 'kb_ingest', order: 470, isTool: isKbIngestTool, execute: (n, a, ctx) => executeKbIngestTool(n, a, { orgId: ctx.orgId, userId: ctx.userId }) },
];

function registerIntegrationToolFamilies() {
    for (const family of INTEGRATION_TOOL_FAMILIES) registerToolFamily(family);
}

registerIntegrationToolFamilies();
require('../modules/firstParty/registrationChannels').openChannel('integrations/toolFamilies');

module.exports = { INTEGRATION_TOOL_FAMILIES, registerIntegrationToolFamilies, recordBrowserPeers };
