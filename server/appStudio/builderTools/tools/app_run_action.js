// @typecheck strict
'use strict';
// The in-product counterpart of the Studio MCP tool of the same name (builderTools/runTools.mts):
// a DRY run only. A live run is never reachable from the builder.
const SCOPE = {
    type: 'object',
    description: 'What the click would have in scope: vars (variable values), form (submitted form values by input name), item (the row of a list or grid click), params (what a call_action passes, to test a called action alone), trigger (a mocked trigger root, for an action a trigger starts: { kind: "record", record: { event, row, before, changed, … } } or { kind: "webhook", webhook: { body, headers } }; a test with it still starts no trigger). All optional, together at most 64 KB.',
    properties: { vars: { type: 'object' }, form: { type: 'object' }, item: {}, params: { type: 'object' }, trigger: { type: 'object' } },
};
module.exports = {
    name: 'app_run_action',
    since: 3,
    description: 'Test one action of this app on the server as a DRY run, as the app owner (owner only), and read a per-step report { ok, steps: [{ path, kind, status: ok|skipped|refused|error, result?, error?, ms, mocked? }], vars, notes, runId }. It runs the saved draft you just built. Nothing is written and nothing is sent: a record write comes back as skipped with wouldWrite, a mail as skipped with wouldSend, browser steps are skipped; AI and read steps do run and cost the owner\'s AI budget like a click, unless `mock` gives them a fixed answer (then the run is free and repeatable). Branches and loops are followed; paths look like "steps[0]", "steps[1].then[0]", "steps[2].steps[0]". There is no live run here. Keep a check with app_save_test; read a logged run back with app_get_run.',
    schema: {
        type: 'object',
        properties: {
            actionId: { type: 'string', description: 'The act_… id of the action to run (app_get_draft lists them).' },
            scope: SCOPE,
            mock: { type: 'object', description: 'Fixed model answers by step path, e.g. { "steps[1]": "a summary" } for an AI text step, { "steps[0]": { "rows": [] } } for an extraction. { "$error": "text" } makes the step fail. A mocked step costs nothing.' },
        },
        required: ['actionId'],
    },
    apply: (/** @type {unknown} */ draftWrap, /** @type {unknown} */ args) => require('../runTools.mts').builderRunAction(draftWrap, args),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'studio_apps_tab.act_run_action', en: 'Test-ran an action' },
};
