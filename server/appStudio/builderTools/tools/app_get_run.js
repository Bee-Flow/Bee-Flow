// @typecheck strict
'use strict';
// The in-product counterpart of the Studio MCP tool of the same name (builderTools/runTools.mts).
module.exports = {
    name: 'app_get_run',
    since: 3,
    description: 'One run of this app\'s run log with its steps in order (read-only): per step { path, kind, status: ok|error|skipped|refused|deferred, durationMs, error?, code?, attempts?, handled?, mocked?, ai? }. The first failing step is the run\'s errorStep. No results, inputs or prompts are kept, only what happened and how long it took.',
    schema: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'The sar_… id that app_list_runs, app_run_action or app_run_tests returned.' } },
        required: ['runId'],
    },
    apply: (/** @type {unknown} */ draftWrap, /** @type {unknown} */ args) => require('../runTools.mts').builderGetRun(draftWrap, args),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'studio_apps_tab.act_get_run', en: 'Read a run' },
};
