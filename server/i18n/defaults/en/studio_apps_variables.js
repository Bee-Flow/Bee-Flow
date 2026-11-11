// @typecheck strict
// English GUI defaults — namespace "studio_apps_variables": every key whose part before the first "." is "studio_apps_variables".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_variables.json. App Studio variables added in schema 3: a screen variable, a variable the
// browser keeps for a signed-in viewer, and a variable worked out from a formula (the Variables panel of the editor).
module.exports = {
    "studio_apps_variables.editor.formula": "Formula",
    "studio_apps_variables.editor.formula_aria": "Formula of {name}",
    "studio_apps_variables.editor.formula_example": "vars.price * vars.quantity",
    "studio_apps_variables.editor.kind": "Value",
    "studio_apps_variables.editor.kind_app": "Set by the app",
    "studio_apps_variables.editor.kind_aria": "Kind of {name}",
    "studio_apps_variables.editor.kind_derived": "Worked out from a formula",
    "studio_apps_variables.editor.kind_hint_derived": "Worked out again whenever what the formula reads changes. A step that writes it changes nothing; while the formula gives nothing, the starting value shows.",
    "studio_apps_variables.editor.kind_hint_screen": "Starts from its starting value again each time a screen opens.",
    "studio_apps_variables.editor.kind_screen": "Set by the app, per screen",
    "studio_apps_variables.editor.persist": "Remember after a reload",
    "studio_apps_variables.editor.persist_aria": "Remember {name} after a reload",
    "studio_apps_variables.editor.persist_hint": "Only for signed-in people, in their own browser. Never keep personal data or anything secret here.",
    "studio_apps_variables.editor.persist_local": "On this device",
    "studio_apps_variables.editor.persist_none": "No",
    "studio_apps_variables.editor.persist_session": "Until the browser tab closes",
};
