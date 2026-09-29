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
];

// ─── Tool Execution ───────────────────────────────────────────────

async function executeNextcloudTool(toolName, args, userId, session, extra = {}) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const root = ncClient.webdavRoot(baseUrl, uid);
    const handlerCtx = {
        baseUrl, ncFetch, authError, uid, root, session,
        // Who is asking, in which auth mode, and — inside a routine run —
        // which run: the office tools read the org's house style, build
        // `/f/<id>` links from the PUBLIC base URL (never the connector proxy)
        // and resolve `generated_file` handles against the run's journey.
        mode: ctx.mode || null,
        publicBaseUrl: ctx.publicBaseUrl || null,
        userId,
        orgId: (session && (session.connectorOrgId || (session.user && session.user.organizationId))) || null,
        runScope: (extra && extra.runScope) || null,
    };

    for (const handler of TOOL_HANDLERS) {
        const result = await handler(toolName, args, handlerCtx);
        if (result !== undefined) return result;
    }
    return { error: `Unknown Nextcloud tool: ${toolName}` };
}

function isNextcloudTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_');
}

module.exports = {
    NEXTCLOUD_TOOLS,
    executeNextcloudTool,
    isNextcloudTool,
};
