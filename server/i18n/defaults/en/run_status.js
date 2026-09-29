// English GUI defaults — namespace "run_status": every key whose part before the first "." is "run_status".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Run status vocabulary (Track F, 2026-09) — shared/statusTokens.ts, and
    // the phone's hand port in mobile/src/features/automate/format.ts.
    //
    // NOT studio.status.* above. That set answers "is this thing live?" about
    // a Studio object; this set answers "how did this run or step go?". They
    // share the word "paused" with two different meanings — there an
    // automation is switched off, here a run is halted — so the word gets
    // chosen twice on purpose rather than once by accident.
    "run_status.success": "Finished",
    "run_status.error": "Failed",
    "run_status.running": "Running",
    "run_status.queued": "Waiting to start",
    "run_status.paused": "Paused",
    "run_status.cancelled": "Stopped",
    "run_status.awaiting_approval": "Waiting for approval",
    "run_status.awaiting_form": "Waiting for a form",
    // Two skips, two meanings: a step that never ran because it is switched
    // off, and a step that ran and found nothing to do.
    "run_status.skipped": "Skipped",
    "run_status.nothing_to_do": "Nothing to do",
    "run_status.handled_error": "Recovered",
    "run_status.pinned": "Frozen data",
    // The twin of "pinned": data the author typed rather than captured. A
    // different word on purpose — the two behave identically downstream, and
    // that is exactly why a fabricated value must never read as a capture.
    "run_status.edited": "Edited",
    "run_status.warning": "Warning",
    "run_status.info": "Info",
    "run_status.idle": "Idle",
    // Not a status: the badge that says a run was a test, shown NEXT to the
    // status word rather than instead of it.
    "run_status.dry_run": "dry-run",
};
