// @typecheck strict
// English GUI defaults — namespace "shield_exemptions": every key whose part before the first "." is "shield_exemptions".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// Privacy Shield, "What we look for": the "Exceptions per app" section under the kinds-of-data table.
// Plain English for non-technical admins. The column names match the table's.
module.exports = {
    "shield_exemptions.add": "Add app",
    "shield_exemptions.category_for_app": "{kind} for {app}",
    "shield_exemptions.class_external": "Outside tools",
    "shield_exemptions.class_internal": "Own server",
    "shield_exemptions.empty": "No exceptions yet: every app in this column is held to the whole list.",
    "shield_exemptions.except": "except {apps}",
    "shield_exemptions.explain": "An exception lets one app receive kinds of data this column holds back from every other tool. The AI still only sees placeholders; the real values go to that app alone.",
    "shield_exemptions.hard_note": "API keys and secrets, passport numbers and driving licence numbers stay held back for every app.",
    "shield_exemptions.load_error": "The list of apps could not be loaded. Existing exceptions still apply.",
    "shield_exemptions.may_receive": "{app} may receive",
    "shield_exemptions.no_apps": "None of your organisation's apps can get an exception in this column.",
    "shield_exemptions.none_blocked": "Nothing is held back in this column, so there is nothing to make an exception for.",
    "shield_exemptions.pick_app": "Choose an app",
    "shield_exemptions.remove": "Remove the exception for {app}",
    "shield_exemptions.title": "Exceptions per app",
};
