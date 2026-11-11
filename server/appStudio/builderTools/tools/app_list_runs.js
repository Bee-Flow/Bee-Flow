// @typecheck strict
'use strict';
// The in-product counterpart of the Studio MCP tool of the same name (builderTools/runTools.mts).
module.exports = {
    name: 'app_list_runs',
    since: 3,
    description: 'The run log of this app, newest first (read-only): every action run from a click, a public page, a test run, a background job or a mailbox hook. Per run { id, actionId, origin, status, startedAt, durationMs, stepCount, failedSteps, error, errorStep, ai, actor: { kind, isYou, ref } }; people are never named. Filter with actionId, status ("error" finds the failing runs), origin, user and since; page with nextCursor. Read one run with app_get_run.',
    schema: {
        type: 'object',
        properties: {
            actionId: { type: 'string', description: 'Only runs of this action.' },
            status: { type: 'string', enum: ['running', 'success', 'error', 'interrupted', 'cancelled', 'refused'], description: 'Only runs that ended like this.' },
            origin: { type: 'string', description: 'Comma list of click, public, mcp, test, background, mailbox_hook.' },
            user: { type: 'string', enum: ['me', 'others', 'visitors', 'system'], description: 'Who ran it.' },
            since: { type: 'string', description: 'Only runs started at or after this ISO 8601 date and time.' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Runs per page (default 20).' },
            cursor: { type: 'string', description: 'The nextCursor of the previous page.' },
        },
    },
    apply: (/** @type {unknown} */ draftWrap, /** @type {unknown} */ args) => require('../runTools.mts').builderListRuns(draftWrap, args),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'studio_apps_tab.act_list_runs', en: 'Read the run log' },
};
