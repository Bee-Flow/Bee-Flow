/**
 * The Nextcloud tool family: the per-app executors behind every nextcloud_*
 * tool, and the scope-guarded entry the dispatcher runs them through.
 *
 * ONE enforcement point for the per-user Nextcloud access scope: every
 * nextcloud_* tool — chat, automations, AI tasks, cowork, Studio apps — all
 * funnel through executeTool, and so through executeGuardedNextcloudTool,
 * which passes ncScopeGuard.checkToolCall before the family executor runs and
 * trims the results of 'filter'-policy list tools afterwards. The guard can
 * only deny or filter (narrow-only relative to isAppOn/entitlements) and fails
 * CLOSED when the scope store is unreadable. See core/integrations/ncScopeGuard.js.
 */

const { NOT_HANDLED } = require('../core/tools/toolFamilyRegistry');
const { isNextcloudTool, executeNextcloudTool } = require('./nextcloudTools');
const { isNextcloudCalendarTool, executeNextcloudCalendarTool } = require('./nextcloudCalendarTools');
const { isNextcloudContactsTool, executeNextcloudContactsTool } = require('./nextcloudContactsTools');
const { isNextcloudDeckTool, executeNextcloudDeckTool } = require('./nextcloudDeckTools');
const { isNextcloudNotificationsTool, executeNextcloudNotificationsTool } = require('./nextcloudNotificationsTools');
const { isNextcloudTalkTool, executeNextcloudTalkTool } = require('./nextcloudTalkTools');
const { isNextcloudTasksTool, executeNextcloudTasksTool } = require('./nextcloudTasksTools');
const { isNextcloudNotesTool, executeNextcloudNotesTool } = require('./nextcloudNotesTools');
const { isNextcloudMailTool, executeNextcloudMailTool } = require('./nextcloudMailTools');
const { isNextcloudActivityTool, executeNextcloudActivityTool } = require('./nextcloudActivityTools');
const { isNextcloudTablesTool, executeNextcloudTablesTool } = require('./nextcloudTablesTools');
const { isNextcloudFormsTool, executeNextcloudFormsTool } = require('./nextcloudFormsTools');
const { isNextcloudTeamsTool, executeNextcloudTeamsTool } = require('./nextcloudTeamsTools');
const { isNextcloudStatusTool, executeNextcloudStatusTool } = require('./nextcloudStatusTools');

/**
 * Sub-apps first: the generic executor (last) matches the whole broad
 * "nextcloud_*" prefix, so it must only see what no sub-app owns.
 */
const SUB_APPS = [
    [isNextcloudCalendarTool, executeNextcloudCalendarTool],
    [isNextcloudContactsTool, executeNextcloudContactsTool],
    [isNextcloudDeckTool, executeNextcloudDeckTool],
    [isNextcloudNotificationsTool, executeNextcloudNotificationsTool],
    [isNextcloudTalkTool, executeNextcloudTalkTool],
    [isNextcloudTasksTool, executeNextcloudTasksTool],
    [isNextcloudNotesTool, executeNextcloudNotesTool],
    [isNextcloudMailTool, executeNextcloudMailTool],
    [isNextcloudActivityTool, executeNextcloudActivityTool],
    [isNextcloudTablesTool, executeNextcloudTablesTool],
    [isNextcloudFormsTool, executeNextcloudFormsTool],
    [isNextcloudTeamsTool, executeNextcloudTeamsTool],
    [isNextcloudStatusTool, executeNextcloudStatusTool],
];

/**
 * The Nextcloud family chain WITHOUT the scope guard (callers that are not a
 * tool call, such as the scope picker, and the guarded entry below). Returns
 * undefined when no family matched.
 */
async function executeNextcloudFamilyTool(toolName, toolArgs, userId, session, extra = {}) {
    for (const [isTool, execute] of SUB_APPS) {
        if (isTool(toolName)) return await execute(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTool(toolName)) {
        return await executeNextcloudTool(toolName, toolArgs, userId, session, extra);
    }
    return undefined;
}

/** check → run → filter, for a dispatched nextcloud_* call. */
async function executeGuardedNextcloudTool(toolName, toolArgs, context) {
    const { userId, orgId, session, runScope } = context;
    const ncScopeGuard = require('../core/integrations/ncScopeGuard');
    const denial = await ncScopeGuard.checkToolCall({ toolName, toolArgs, userId, orgId });
    if (denial) return denial;
    const raw = await executeNextcloudFamilyTool(toolName, toolArgs, userId, session, { runScope: runScope || null });
    // No family matched (a nextcloud_-prefixed tool owned elsewhere) — the
    // dispatcher falls through to the families and fallbacks after this one.
    if (raw === undefined) return NOT_HANDLED;
    return await ncScopeGuard.filterResult({ toolName, result: raw, userId, orgId });
}

/**
 * A Nextcloud tool run on behalf of another tool (create_presentation's "save
 * it in Nextcloud"): the scope guard's denial, or the family's result. Not
 * filtered — a create answers with what it made, not a list.
 */
async function executeCheckedNextcloudTool(toolName, toolArgs, { userId, orgId, session, runScope }) {
    const ncScopeGuard = require('../core/integrations/ncScopeGuard');
    return (await ncScopeGuard.checkToolCall({ toolName, toolArgs, userId, orgId }))
        || await executeNextcloudFamilyTool(toolName, toolArgs, userId, session, { runScope: runScope || null });
}

function isNextcloudFamilyToolName(toolName) {
    return toolName.startsWith('nextcloud_');
}

module.exports = {
    executeNextcloudFamilyTool,
    executeGuardedNextcloudTool,
    executeCheckedNextcloudTool,
    isNextcloudFamilyToolName,
};
