// @typecheck strict
'use strict';
// The in-product counterpart of the Studio MCP tool of the same name (builderTools/runTools.mts).
module.exports = {
    name: 'app_save_test',
    since: 3,
    description: 'Save (or replace, by actionId + name) a repeatable TEST of one action: a scope, optional mocks and expectations, kept with the app but outside its definition. remove: true deletes the test by actionId + name. Run saved tests with app_run_tests. expect is a list of { path, op, value }: path is ok, stopped, vars.<name>, result.… (the last server step\'s result) or a step path with .status, .result…, .error, .count, .mocked (e.g. "steps[0].result.rows[0].name", "steps[1].status"); op is one of is, isNot, eq, neq, contains, notContains, startsWith, endsWith, gt, gte, lt, lte, isEmpty, isNotEmpty. mock and scope are as in app_run_action. Returns hints, for example an AI step that is not mocked.',
    schema: {
        type: 'object',
        properties: {
            actionId: { type: 'string', description: 'The act_… id of the action the test runs.' },
            name: { type: 'string', description: 'The test name, unique per action (1-80 characters).' },
            scope: { type: 'object', description: 'As app_run_action scope: { vars?, form?, item?, params? }.', properties: { vars: { type: 'object' }, form: { type: 'object' }, item: {}, params: { type: 'object' } } },
            mock: { type: 'object', description: 'As app_run_action mock: { "<step path>": <model answer> }.' },
            expect: {
                type: 'array',
                description: '1-50 expectations; each must hold.',
                items: { type: 'object', properties: { path: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['path', 'op'] },
            },
            remove: { type: 'boolean', description: 'true: delete the test (actionId + name) instead of saving it.' },
        },
        required: ['actionId', 'name'],
    },
    apply: (/** @type {unknown} */ draftWrap, /** @type {unknown} */ args) => require('../runTools.mts').builderSaveTest(draftWrap, args),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'studio_apps_tab.act_save_test', en: 'Saved a test' },
};
