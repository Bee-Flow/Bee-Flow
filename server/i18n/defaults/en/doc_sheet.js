// @typecheck strict
// English GUI defaults — namespace "doc_sheet": every key whose part before the first "." is "doc_sheet".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "doc_sheet.chart.failed": "The charts of this spreadsheet could not be saved or loaded. Try again.",
    "doc_sheet.chart.save_failed": "Could not save the chart. Try again.",
    "doc_sheet.error.busy": "Someone else is changing the same row right now. Try again in a moment.",
    "doc_sheet.error.cell_too_long": "A cell holds too much text. Shorten it and try again.",
    "doc_sheet.error.cells_missing": "The cells of this spreadsheet are no longer there. They may have been deleted.",
    "doc_sheet.error.last_tab": "A spreadsheet needs at least one tab, so the last one cannot be deleted.",
    "doc_sheet.error.not_found": "This spreadsheet no longer exists.",
    "doc_sheet.error.out_of_range": "A spreadsheet has columns A to Z and at most 2,000 rows. Some cells fall outside that.",
    "doc_sheet.error.read_only": "You can read this spreadsheet, but only its editors can change it.",
    "doc_sheet.error.tab_not_found": "This tab no longer exists. Reload the spreadsheet to see the tabs it has now.",
    "doc_sheet.error.too_many_cells": "Too many cells were changed at once. Change a smaller part at a time.",
    "doc_sheet.error.usage_limit": "Your usage limit has been reached. Try again later or ask your administrator.",
    "doc_sheet.limit.paste_columns": "A spreadsheet has columns A to Z; {count} columns were not pasted.",
    "doc_sheet.limit.paste_rows": "A spreadsheet has at most 2,000 rows; {count} rows were not pasted.",
    "doc_sheet.limit.rows": "A spreadsheet has at most 2,000 rows.",
    "doc_sheet.tab.add_failed": "Could not add a tab.",
    "doc_sheet.tab.delete_body": "The tab \"{name}\" and everything on it, its charts included, are deleted. This cannot be undone.",
    "doc_sheet.tab.delete_confirm": "Delete tab",
    "doc_sheet.tab.delete_failed": "Could not delete the tab.",
    "doc_sheet.tab.delete_title": "Delete this tab?",
    "doc_sheet.tab.rename_failed": "Could not rename the tab.",
    "doc_sheet.unsaved.body": "{reason} If you go on, the changes that were not saved are lost.",
    "doc_sheet.unsaved.leave": "Leave anyway",
    "doc_sheet.unsaved.stay": "Stay",
    "doc_sheet.unsaved.title": "Your last changes are not saved",
};
