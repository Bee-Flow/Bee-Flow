// @typecheck strict
// English GUI defaults — namespace "project_activity": every key whose part before the first "." is "project_activity".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/project_activity.json. Project activity feed: sentences for actions the project_home feed had no words for (sprints, ownership, archive, Solution stages), and the fallback for an action this client does not know.
module.exports = {
    "project_activity.sprint_created": "{actor} planned a sprint",
    "project_activity.sprint_deleted": "{actor} deleted a sprint",
    "project_activity.owner_changed": "{actor} made {subject} the owner",
    "project_activity.project_archived": "{actor} archived the project",
    "project_activity.project_restored": "{actor} restored the project from the archive",
    "project_activity.stage_created": "{actor} added a stage to this Solution",
    "project_activity.stage_detached": "{actor} detached a stage from this Solution",
    "project_activity.stage_paused": "{actor} paused the automations of a stage",
    "project_activity.stage_resumed": "{actor} resumed the automations of a stage",
    "project_activity.other": "{actor} made a change",
};
