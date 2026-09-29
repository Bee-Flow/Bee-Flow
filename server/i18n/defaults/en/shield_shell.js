// English GUI defaults — namespace "shield_shell": every key whose part before the first "." is "shield_shell".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// Privacy Shield (round 3): the header, the path strip and the save bar shared by every pane.
// Plain English for non-technical admins. Setting names stay as they are elsewhere.
module.exports = {
    // The header's detection pill, healthy state. "checked", not "last check":
    // "last check" is the product's name for the pre-flight on step 4.
    "shield_shell.guard_running": "Detection running",
    "shield_shell.guard_running_checked": "Detection running · checked {when}",
    // The path strip's read-outs.
    "shield_shell.path_label": "Path",
    "shield_shell.summary_review": "{n} to review",
    "shield_shell.summary_kinds": "{n} of {total} kinds",
    "shield_shell.summary_replace": "replace with placeholders",
    "shield_shell.summary_tools_open": "tools open",
    "shield_shell.summary_last_days": "last {n} days",
    // The save bar.
    "shield_shell.save_changes": "Save changes",
    // Singular of admin.shield_unsaved_on ("on {n} steps:").
    "shield_shell.unsaved_on_one": "on 1 step:",
    // "How this works", numbered like the path strip (step 3 = when we find
    // something, step 4 = leaving your org).
    "shield_shell.hiw_two_checks_lead": "Steps 3 and 4 are not alternatives.",
    "shield_shell.hiw_two_checks": "Step 3 is the gate that always closes; step 4 is one extra look, only before a model outside your organisation, and the only place an employee gets a say. Stopping the message at step 3 does not produce the Ask dialog — that is step 4 on “Ask”.",
};
