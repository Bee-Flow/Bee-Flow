// @typecheck strict
'use strict';
// Change one step of an action by its walker path (builderTools/stepPathEdit.mts).
module.exports = {
    name: 'app_update_step',
    since: 3,
    description: 'Change ONE step of an existing action, addressed by its path, without resending the whole action. path is the step path app_run_action and app_get_run report: "steps[0]", "steps[1].then[0]", "steps[2].steps[0]" (a loop body), "steps[0].cases[1].steps[0]", "steps[0].onError.steps[0]"; "action[0]" is an action that is a single step. Pass patch to set fields of that step (a field set to null is removed; a branch list you pass replaces that list) or step to replace it whole. Every other step is left exactly as it was. The changed action is checked like app_set_action: a step that would fail is refused and nothing changes. Returns the step as saved. Read the action with app_get_action first. A path into a called action (".call.") is refused with the action to edit instead.',
    schema: {
        type: 'object',
        properties: {
            actionId: { type: 'string', description: 'The act_… id of the action.' },
            path: { type: 'string', description: 'The step path, e.g. "steps[1].then[0]".' },
            patch: { type: 'object', description: 'The fields to set on the step; null removes a field.' },
            step: { type: 'object', description: 'The whole new step, with its kind (instead of patch).' },
        },
        required: ['actionId', 'path'],
    },
    apply: (/** @type {Parameters<typeof import('../stepPathEdit.mts').applyUpdateStep>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../stepPathEdit.mts').applyUpdateStep(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_update_step', en: 'Changed a step' },
};
