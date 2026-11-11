// @typecheck strict
'use strict';
// The in-product counterpart of the Studio MCP tool of the same name (builderTools/runTools.mts).
module.exports = {
    name: 'app_run_tests',
    since: 3,
    description: 'Run the saved tests of this app (app_save_test) against the saved draft, always as a dry run, as the app owner (owner only). Reports a summary and per test pass | fail | error | not_run with the failing expectations { path, op, expected, actual }, the steps of a test that did not pass, wasStatus (the previous result) and runId. Mocked AI steps are free. Leave both filters out to run every test.',
    schema: {
        type: 'object',
        properties: {
            actionIds: { type: 'array', items: { type: 'string' }, description: 'Only the tests of these actions (at most 50).' },
            names: { type: 'array', items: { type: 'string' }, description: 'Only the tests with these names (at most 50).' },
        },
    },
    apply: (/** @type {unknown} */ draftWrap, /** @type {unknown} */ args) => require('../runTools.mts').builderRunTests(draftWrap, args),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'studio_apps_tab.act_run_tests', en: 'Ran the tests' },
};
