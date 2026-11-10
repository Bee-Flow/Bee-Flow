// @typecheck strict
// English GUI defaults — namespace "studio_apps_validation": every key whose part before the first "." is "studio_apps_validation".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_validation.json. App Studio field rules: the validation and dynamic-default controls of a
// data-model field in the table editor.
module.exports = {
    "studio_apps_validation.heading": "Rules",
    "studio_apps_validation.hint": "Checked every time this field is saved. Rows already stored are not checked again.",
    "studio_apps_validation.min": "Minimum",
    "studio_apps_validation.max": "Maximum",
    "studio_apps_validation.min_length": "Minimum length",
    "studio_apps_validation.max_length": "Maximum length",
    "studio_apps_validation.pattern": "Pattern",
    "studio_apps_validation.pattern_hint": "A regular expression the text must match, for example ^[0-9]{4}$",
    "studio_apps_validation.enforce_options": "Only the listed choices",
    "studio_apps_validation.message": "Error message",
    "studio_apps_validation.message_hint": "Shown instead of the generated message when a rule is not met.",
    "studio_apps_validation.dynamic_default": "Fill when a record is created",
    "studio_apps_validation.dynamic_none": "Nothing",
    "studio_apps_validation.dynamic_now": "The current date and time",
    "studio_apps_validation.dynamic_today": "Today's date",
    "studio_apps_validation.dynamic_user": "The signed-in user",
};
