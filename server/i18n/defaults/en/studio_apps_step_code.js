// @typecheck strict
// English GUI defaults — namespace "studio_apps_step_code": every key whose part before the first "." is "studio_apps_step_code".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_step_code.json. App Studio code step: its palette entry and the controls of its
// fields in the step editor (the code box, the inputs, the time limit).
module.exports = {
    "studio_apps_step_code.catalog.blurb": "Work out a value with a few lines of JavaScript over the inputs you pass in. No network, no database.",
    "studio_apps_step_code.catalog.label": "Run code",
    "studio_apps_step_code.field.contract": "Write function main(inputs, ctx) and return a value: it lands in vars.<result variable>. ctx.log(…) notes a line. There is no network, no database and no integrations; write with a step after this one.",
    "studio_apps_step_code.field.inputs": "Your code reads: {names}",
    "studio_apps_step_code.field.inputs_hint": "Each input is read before the code runs, with the row access of whoever runs the action, and reaches the code as inputs.<name>.",
    "studio_apps_step_code.field.length": "{count} of {max} characters.",
    "studio_apps_step_code.field.no_inputs": "No inputs yet: add them under Inputs, each a value, a formula or rows of a table.",
    "studio_apps_step_code.field.timeout_hint": "Leave empty for the default (1 s of computing within 5 s). At most 30000.",
    "studio_apps_step_code.field.timeout_label": "Time limit (ms)",
    "studio_apps_step_code.field.too_long": "{count} of at most {max} characters: shorten the code.",
};
