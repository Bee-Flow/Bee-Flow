// @typecheck strict
// English GUI defaults — namespace "studio_apps_durable": every key whose part before the first "." is "studio_apps_durable".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_durable.json. App Studio server runs: the "run on the server" option of an action, a run
// that is on hold (waiting), and cancelling a run from the page and from the run log.
module.exports = {
    "studio_apps_durable.options.run_on_hint": "The page sends one request and waits for the result, instead of doing the steps one by one. The action then finishes even when the connection drops halfway. Navigation and dialogs cannot be part of it; messages and refreshes show when it ends.",
    "studio_apps_durable.options.run_on_label": "Run the whole action on the server",
    "studio_apps_durable.runs.cancel": "Cancel run",
    "studio_apps_durable.runs.cancel_failed": "The run could not be cancelled. Try again.",
    "studio_apps_durable.runs.cancelled": "The run was cancelled.",
    "studio_apps_durable.runs.cancelling": "The run stops before its next step.",
    "studio_apps_durable.runs.status_paused": "On hold",
    "studio_apps_durable.tray.cancel": "Cancel",
    "studio_apps_durable.tray.cancel_failed": "The run could not be cancelled. Try again.",
    "studio_apps_durable.tray.cancelled": "Cancelled",
    "studio_apps_durable.tray.cancelling": "Stopping…",
    "studio_apps_durable.tray.on_hold": "This is waiting now and goes on by itself. You can close the page.",
    "studio_apps_durable.tray.waiting_approval": "Waiting for an approval",
    "studio_apps_durable.tray.waiting_open": "Waiting to be continued",
    "studio_apps_durable.tray.waiting_until": "Waiting until {time}",
};
