// @typecheck strict
// English GUI defaults — namespace "admin_ui": every key whose part before the first "." is "admin_ui".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/admin_ui.json. The shared admin primitives: the save bar, its leave guard and the date-range control.
module.exports = {
    "admin_ui.discard": "Discard",
    "admin_ui.leave_desc": "The changes you made here have not been saved.",
    "admin_ui.leave_discard": "Discard changes",
    "admin_ui.leave_title": "Discard unsaved changes?",
    "admin_ui.range_from": "From",
    "admin_ui.range_to": "To",
    "admin_ui.save_changes": "Save changes",
    "admin_ui.unsaved": "Unsaved changes",
};
