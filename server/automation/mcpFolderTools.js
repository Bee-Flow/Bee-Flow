// @typecheck
'use strict';
/**
 * The folder tools of the automations MCP server (mcpFolders.mts) wired to the
 * real stores: the product's folder store, the account's organisation, and a
 * per-user write budget. Nothing is loaded from the database layer until a
 * tool is called.
 */

const { FOLDER_TOOLS, FOLDER_TOOL_NAMES, FOLDER_WRITE_TOOL_NAMES, guideSection, makeFolderTools } = require('./mcpFolders.mts');
const { envCap } = require('./mcpRunReadCaps');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const log = require('../telemetry/log');

let limiter = null;
/**
 * `cost` units of the folder write budget of one user: AUTOMATION_MCP_FOLDER_WRITES_PER_MINUTE
 * (default 120, 0 = unlimited). Shared across replicas when Redis is there.
 */
async function charge(userId, cost) {
    const rpm = envCap('AUTOMATION_MCP_FOLDER_WRITES_PER_MINUTE', 120);
    if (rpm <= 0) return true;
    if (!limiter || limiter.rpm !== rpm) {
        limiter = {
            rpm,
            check: perUserRateLimit({ windowMs: 60_000, max: rpm, name: 'automation-mcp-folder-writes', costFn: (req) => req.cost }).check,
        };
    }
    const res = { set() { return res; }, status() { return res; }, json() { return res; } };
    return limiter.check({ session: { user: { id: userId } }, cost }, res);
}

/**
 * The organisation folders live in for this account (the same one the sidebar
 * uses) and every organisation it belongs to. Throws when either cannot be read.
 */
async function caller(userId) {
    const { resolveDatatablePrincipalForUser } = require('../auth/datatableAccess');
    /** @type {any} */
    const principal = await resolveDatatablePrincipalForUser(userId);
    if (!principal.userId || principal.identityError) throw new Error(principal.identityError || 'unknown account');
    const user = await require('../stores/userStore').getUser(userId);
    const { all } = await require('../auth/mcpAccess/orgResolve').resolveMcpOrgs(user);
    return { orgId: principal.orgId ?? null, memberOrgIds: all };
}

const tools = makeFolderTools({
    store: {
        listFolders: (...a) => require('../stores/automationStore').listFolders(...a),
        createFolder: (...a) => require('../stores/automationStore').createFolder(...a),
        moveFolder: (...a) => require('../stores/automationStore').moveFolder(...a),
        requireFolderForAutomation: (...a) => require('../stores/automationStore').requireFolderForAutomation(...a),
        getAutomation: (...a) => require('../stores/automationStore').getAutomation(...a),
        updateAutomation: (...a) => require('../stores/automationStore').updateAutomation(...a),
    },
    caller,
    charge,
    log,
});

module.exports = {
    FOLDER_TOOLS,
    FOLDER_TOOL_NAMES,
    FOLDER_WRITE_TOOL_NAMES,
    callFolderTool: tools.call,
    guideSection,
    makeFolderTools,
};
