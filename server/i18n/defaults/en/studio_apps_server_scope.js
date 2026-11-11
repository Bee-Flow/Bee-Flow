// @typecheck strict
// English GUI defaults — namespace "studio_apps_server_scope": every key whose part before the first "." is "studio_apps_server_scope".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_server_scope.json. App Studio server steps: the guard a server step checks before it
// runs, and the app setting that lets server steps read the screen, the other forms and action results.
module.exports = {
    'studio_apps_server_scope.explainer': 'A step that saves, sends or asks the AI runs on the server. Without this, a formula in such a step reads screen, forms and actions as empty. With it, the browser sends them along with the step. They are what the person on the screen entered, so use currentUser and roles, not these, to decide who may do something. A public page, a background action and the phone app do not send them.',
    'studio_apps_server_scope.field_guard': 'Only run when (checked on the server)',
    'studio_apps_server_scope.hint_guard': 'A formula the server works out before this step. When it is not true the step is skipped and the rest goes on. Leave it empty to always run the step.',
    'studio_apps_server_scope.title': 'Server steps',
    'studio_apps_server_scope.toggle': 'Let server steps read the screen, other forms and action results',
};
