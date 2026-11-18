// @typecheck strict
// English GUI defaults — namespace "studio_apps_step_sanctions": every key whose part before the first "." is "studio_apps_step_sanctions".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_step_sanctions.json. App Studio sequence step editor: the sanctions_screen step
// ("Screen against sanctions lists"), its name in the step palette and the labels and hints of its settings.
module.exports = {
    "studio_apps_step_sanctions.blurb": "Check a name against the EU, UN, Dutch, OFAC and UK sanctions lists, and a job title for a PEP function.",
    "studio_apps_step_sanctions.field_birth_date": "Birth date",
    "studio_apps_step_sanctions.field_function": "Job title or function",
    "studio_apps_step_sanctions.field_max_results": "Most candidates",
    "studio_apps_step_sanctions.field_min_score": "Lowest score",
    "studio_apps_step_sanctions.hint_birth_date": "Optional. Lowers the score of namesakes born in another year.",
    "studio_apps_step_sanctions.hint_country": "Optional. Nationality or country, such as NL or Netherlands.",
    "studio_apps_step_sanctions.hint_function": "Optional. Checked against the Dutch and EU lists of prominent public functions.",
    "studio_apps_step_sanctions.hint_lists": "Leave empty to screen against every list.",
    "studio_apps_step_sanctions.hint_min_score": "From 0.5 to 1. Lower finds more spellings, and more namesakes.",
    "studio_apps_step_sanctions.hint_name": "The full name of the person or organisation.",
    "studio_apps_step_sanctions.hint_result_var": "The variable that gets the result: vars.<name>.candidates, vars.<name>.candidateCount and vars.<name>.pep.",
    "studio_apps_step_sanctions.label": "Screen against sanctions lists",
};
