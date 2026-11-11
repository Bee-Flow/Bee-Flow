// @typecheck strict
// English GUI defaults — namespace "studio_apps_h2": every key whose part before the first "." is "studio_apps_h2".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_h2.json. App Studio waits: the wait step that can last hours or days in a run on the
// server, the step that asks for an approval and waits for the decision, and what a run on hold waits for.
module.exports = {
    "studio_apps_h2.await_approval.blurb": "Ask for an approval and go on with the decision. Needs an action that runs on the server.",
    "studio_apps_h2.await_approval.field_timeout": "Close the request after (hours)",
    "studio_apps_h2.await_approval.hint_result_var": "Gets the decision: vars.<name>.decision is approved, rejected, expired or cancelled; vars.<name>.answers holds the answers.",
    "studio_apps_h2.await_approval.hint_timeout": "Then the step goes on with decision \"expired\". Empty: wait until someone decides.",
    "studio_apps_h2.await_approval.label": "Ask and wait for approval",
    "studio_apps_h2.runs.approval": "Waiting for an approval",
    "studio_apps_h2.runs.approval_closes": "{who}; the request closes {time}",
    "studio_apps_h2.runs.open": "Waiting to be continued",
    "studio_apps_h2.runs.until": "Waiting until {time}",
    "studio_apps_h2.tray.by_a_group": "Waiting for approval by the group asked",
    "studio_apps_h2.tray.by_group": "Waiting for approval by {name}",
    "studio_apps_h2.tray.by_owner": "Waiting for approval by the app owner",
    "studio_apps_h2.tray.by_panel": "Waiting for approval by {count} approvers",
    "studio_apps_h2.tray.by_person": "Waiting for approval by {name}",
    "studio_apps_h2.tray.by_someone": "Waiting for approval by the person asked",
    "studio_apps_h2.tray.by_stages": "Waiting for approval in {count} stages",
    "studio_apps_h2.wait.blurb": "Pause before the next step: a few seconds in the browser, or hours and days when the action runs on the server.",
    "studio_apps_h2.wait.field_until": "Wait until",
    "studio_apps_h2.wait.hint_seconds": "In the browser at most 30. When the action runs on the server, longer waits put the run on hold.",
    "studio_apps_h2.wait.hint_until": "A date and time instead of seconds. Only when the action runs on the server.",
    "studio_apps_h2.wait.runtime_too_long": "This wait is longer than a page can hold. It needs an action that runs on the server.",
};
