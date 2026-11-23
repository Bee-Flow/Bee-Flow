// @typecheck strict
// English GUI defaults — namespace "project_counts": every key whose part before the first "." is "project_counts".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/project_counts.json. Counts in a project's pages: the singular forms (`_one`) next to the plural keys of project_home and project_tasks, and what a count on the Planning tabs counts.
module.exports = {
    "project_counts.people_one": "{count} person",
    "project_counts.people": "{count} people",
    "project_counts.groups_one": "{count} group",
    "project_counts.groups": "{count} groups",
    "project_counts.weeks_one": "{count} week",
    "project_counts.new_messages_one": "{n} new message",
    "project_counts.backlog_hint": "Open tasks that are not in a sprint",
    "project_counts.unscheduled_hint": "Tasks without a start or due date",
};
