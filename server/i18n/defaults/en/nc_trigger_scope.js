// @typecheck strict
// English GUI defaults — namespace "nc_trigger_scope": every key whose part before the first "." is "nc_trigger_scope".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Automation builder, Nextcloud trigger: the "also colleagues' events" switch (filter.includeColleagues).
    "nc_trigger_scope.label": "Colleagues",
    "nc_trigger_scope.include_colleagues": "Also react to events of colleagues",
    "nc_trigger_scope.hint": "Off: only what you do yourself starts this automation. On: a colleague's message, card, row, form submission, file change or calendar event starts it too, but only when it is about a room, board, table, form, file or calendar you can see in Nextcloud yourself.",
};
