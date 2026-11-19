// @typecheck strict
// English GUI defaults — namespace "wizard_skills": every key whose part before the first "." is "wizard_skills".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "wizard_skills.title": "Suggested skills",
    "wizard_skills.intro": "Choose the skills to add to this agent. You can change them later in the skill editor.",
    "wizard_skills.static": "Always on",
    "wizard_skills.dynamic": "When relevant",
    "wizard_skills.static_hint": "Its instructions are part of every answer.",
    "wizard_skills.dynamic_hint": "Loaded only when a task needs it.",
    "wizard_skills.include": "Add this skill",
    "wizard_skills.details_show": "Show details",
    "wizard_skills.details_hide": "Hide details",
    "wizard_skills.edit": "Edit",
    "wizard_skills.edit_done": "Done",
    "wizard_skills.name_label": "Name",
    "wizard_skills.summary_label": "What it does",
    "wizard_skills.when_label": "When to use it",
    "wizard_skills.steps_label": "Steps",
    "wizard_skills.rules_label": "Rules",
    "wizard_skills.rule_never": "Never",
    "wizard_skills.rule_must": "Always",
    "wizard_skills.plain_note": "Instructions only. Add steps and rules in the skill editor.",
    "wizard_skills.add": "Add selected skills ({count})",
    "wizard_skills.skip": "Not now",
    "wizard_skills.busy": "Adding…",
    "wizard_skills.added": "Added {count} skill(s) to this agent.",
    "wizard_skills.skipped": "No skills added.",
    "wizard_skills.failed": "The skills could not be added. Try again.",
};
