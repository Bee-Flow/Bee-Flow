// @typecheck strict
// English GUI defaults — namespace "studio_apps_flow_control": every key whose part before the first "." is "studio_apps_flow_control".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_flow_control.json. App Studio control-flow steps (return, break, continue, while,
// raise_error, try): their names in the step palette, the branch labels on the flow canvas and what the
// running app says when one of them cannot run.
module.exports = {
    "studio_apps_flow_control.catalog.break_blurb": "Stop repeating and go on with the step after the loop.",
    "studio_apps_flow_control.catalog.break_label": "Leave the loop",
    "studio_apps_flow_control.catalog.continue_blurb": "Skip the rest of this round of the loop.",
    "studio_apps_flow_control.catalog.continue_label": "Skip to the next round",
    "studio_apps_flow_control.catalog.raise_error_blurb": "Fail the action on purpose, with your own message.",
    "studio_apps_flow_control.catalog.raise_error_label": "Stop with an error",
    "studio_apps_flow_control.catalog.return_blurb": "End the action now, optionally handing back a value.",
    "studio_apps_flow_control.catalog.return_label": "Stop here",
    "studio_apps_flow_control.catalog.try_blurb": "Run steps and decide what happens when one of them fails.",
    "studio_apps_flow_control.catalog.try_label": "Try",
    "studio_apps_flow_control.catalog.while_blurb": "Run these steps again and again while a condition holds.",
    "studio_apps_flow_control.catalog.while_label": "Repeat while",
    "studio_apps_flow_control.runtime.not_in_loop": "A {kind} step only works inside a loop or while.",
    "studio_apps_flow_control.runtime.raised": "The action raised an error.",
    "studio_apps_flow_control.scope.try_catch": "If a step fails",
    "studio_apps_flow_control.scope.try_finally": "Always, at the end",
    "studio_apps_flow_control.scope.try_steps": "Try",
    "studio_apps_flow_control.scope.while_steps": "While it holds",
};
