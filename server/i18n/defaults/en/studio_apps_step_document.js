// @typecheck strict
// English GUI defaults — namespace "studio_apps_step_document": every key whose part before the first "." is "studio_apps_step_document".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_step_document.json. App Studio sequence step editor: the generate_document step
// ("Make a PDF or Word file"), its name in the step palette and the labels and hints of its settings.
module.exports = {
    "studio_apps_step_document.blurb": "Turn text, such as a report or an AI summary, into a PDF or Word file.",
    "studio_apps_step_document.field_ai_generated": "Written by AI",
    "studio_apps_step_document.field_content": "Text",
    "studio_apps_step_document.field_content_format": "Text format",
    "studio_apps_step_document.field_file_name": "File name",
    "studio_apps_step_document.field_format": "File type",
    "studio_apps_step_document.field_house_style": "House style",
    "studio_apps_step_document.hint_ai_generated": "On when the text comes from an AI step: the file then carries the organisation’s AI marking.",
    "studio_apps_step_document.hint_attach_field": "The file column of that record. Set both or neither.",
    "studio_apps_step_document.hint_attach_record": "With a file column, everyone who can read this record can download the file. Without, only the app owner can.",
    "studio_apps_step_document.hint_content": "Markdown: # headings, lists, tables. For example the text an AI step wrote (vars.<name>.text) or a template over the record.",
    "studio_apps_step_document.hint_file_name": "Without extension; .pdf or .docx is added.",
    "studio_apps_step_document.hint_house_style": "A Word file uses the organisation’s Word house style. Off: a neutral document.",
    "studio_apps_step_document.hint_result_var": "The variable that gets the file, for a download, a preview or an e-mail attachment.",
    "studio_apps_step_document.hint_title": "Optional. The heading of the first page and the title of the file.",
    "studio_apps_step_document.label": "Make a PDF or Word file",
};
