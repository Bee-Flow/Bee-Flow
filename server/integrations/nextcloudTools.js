// @typecheck strict
/**
 * Nextcloud Tools — AI tools for files via WebDAV + OCS.
 *
 * Dual-mode auth:
 *   • Bearer (preferred when the user logged in via Nextcloud OAuth) —
 *     uses session.accessToken with automatic 401-refresh through
 *     nextcloudClient.ncFetch. Mirrors the Google/Microsoft pattern so
 *     tools are available in direct chat the moment the user logs in.
 *   • Basic (fallback) — username + app password from userStore. Used by
 *     users who didn't log in via Nextcloud OAuth (e.g. logged in via
 *     Google/Microsoft and connected Nextcloud as a side integration).
 *
 * The Nextcloud base URL is read from the global oauth.nextcloudUrl config,
 * so admins configure it once for the whole tenant — same place OAuth SSO
 * uses.
 *
 * The tool schemas and the handlers live per family in ./nextcloudFiles/; this
 * file resolves auth once and hands the call to the family that owns it.
 */

const ncClient = require('./nextcloudClient');
const { NEXTCLOUD_TOOLS } = require('./nextcloudFiles/toolDefinitions');
const { executeFileOperationTool } = require('./nextcloudFiles/fileOperations');
const { executeSearchTool } = require('./nextcloudFiles/search');
const { executeOfficeDocumentTool } = require('./nextcloudFiles/officeDocuments');
const { executeShareTool } = require('./nextcloudFiles/sharing');
const { executeCommentTool } = require('./nextcloudFiles/comments');
const { executeTagTool } = require('./nextcloudFiles/tags');
const { executeTrashTool } = require('./nextcloudFiles/trash');
const { executeVersionTool } = require('./nextcloudFiles/versions');
const { NEXTCLOUD_REQUEST_TOOLS, executeNextcloudRequest, isNextcloudRequestTool } = require('./nextcloudRequestTool.mts');

/**
 * The generic `nextcloud_request` (automations only, ./nextcloudRequestTool.mts).
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {import('./nextcloudFiles/webdav').FilesToolCtx} ctx
 */
async function executeRequestTool(toolName, args, ctx) {
    return isNextcloudRequestTool(toolName) ? executeNextcloudRequest(args, ctx) : undefined;
}

// Each handler answers for its own family and returns undefined for anything
// else; the tool names are disjoint, so the order here is not semantics.
const TOOL_HANDLERS = [
    executeFileOperationTool,
    executeSearchTool,
    executeOfficeDocumentTool,
    executeShareTool,
    executeCommentTool,
    executeTagTool,
    executeTrashTool,
    executeVersionTool,
    executeRequestTool,
];

// ─── Tool Execution ───────────────────────────────────────────────

/**
 * The automation run a call belongs to: the run (generated_file handles) and
 * the automation, both set by the automation runner only; nextcloud_request
 * refuses a call that has neither.
 * @param {{ runScope?: import('./nextcloudFiles/webdav').FilesToolCtx['runScope'], automationId?: string | null } | undefined} extra
 */
function runContext(extra) {
    return { runScope: extra?.runScope || null, automationId: extra?.automationId || null };
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string} userId
 * @param {Partial<Express.Session> | null | undefined} session
 * @param {{ runScope?: import('./nextcloudFiles/webdav').FilesToolCtx['runScope'], automationId?: string | null }} [extra]
 */
async function executeNextcloudTool(toolName, args, userId, session, extra = {}) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const root = ncClient.webdavRoot(baseUrl, uid);
    const handlerCtx = {
        baseUrl, ncFetch, authError, uid, root, session,
        // Who is asking, in which auth mode, and — inside an automation run —
        // which run: the office tools read the org's house style, build
        // `/f/<id>` links from the PUBLIC base URL (never the connector proxy)
        // and resolve `generated_file` handles against the run's journey.
        mode: ctx.mode || null,
        publicBaseUrl: ctx.publicBaseUrl || null,
        userId,
        orgId: (session && (session.connectorOrgId || (session.user && session.user.organizationId))) || null,
        ...runContext(extra),
    };

    for (const handler of TOOL_HANDLERS) {
        let result;
        try {
            result = await handler(toolName, args, handlerCtx);
        } catch (e) {
            // joinDavPath refuses "." and ".." segments: a bad argument, not a crash.
            if (e && e.code === 'NC_BAD_PATH') return { error: e.message };
            throw e;
        }
        if (result !== undefined) return result;
    }
    return { error: `Unknown Nextcloud tool: ${toolName}` };
}

/**
 * The bytes of one image in this user's Nextcloud, for an automation step that
 * shows the picture to a model (core/automationRunner/aiStepImages.mts). Not a
 * tool: the same auth as executeNextcloudTool, then ./nextcloudFiles/readImage.mts.
 * @param {string} path
 * @param {string} userId
 * @param {Partial<Express.Session> | null | undefined} session
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<import('./nextcloudFiles/readImage.mts').ImageRead>}
 */
async function loadNextcloudImage(path, userId, session, opts = {}) {
    const auth = await ncClient.resolveAuth(session, userId);
    const root = ncClient.webdavRoot(auth.baseUrl, auth.uid);
    const { readNextcloudImage } = require('./nextcloudFiles/readImage.mts');
    return readNextcloudImage(path, { ncFetch: auth.fetch, root, authError: auth.authError }, opts);
}

/** @param {unknown} toolName */
function isNextcloudTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_');
}

/**
 * Every tool of the Nextcloud Files app, the automation-only nextcloud_request
 * included: what the tool registry (automation/toolRegistry.js) attributes to
 * the app, so the catalog, the side-effect map and activation know it. Chat,
 * agents and MCP are offered NEXTCLOUD_TOOLS, which leaves it out.
 */
const NEXTCLOUD_CATALOG_TOOLS = [...NEXTCLOUD_TOOLS, ...NEXTCLOUD_REQUEST_TOOLS];

module.exports = {
    NEXTCLOUD_TOOLS,
    NEXTCLOUD_REQUEST_TOOLS,
    NEXTCLOUD_CATALOG_TOOLS,
    executeNextcloudTool,
    loadNextcloudImage,
    isNextcloudTool,
};
