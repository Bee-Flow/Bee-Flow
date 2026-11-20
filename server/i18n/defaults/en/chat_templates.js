// @typecheck strict
// English GUI defaults — namespace "chat_templates": every key whose part before the first "." is "chat_templates".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "chat_templates.menu_label": "Fill in a template",
    "chat_templates.menu_hint": "Pick one of your templates and fill it in together with the assistant",
    "chat_templates.search_placeholder": "Search templates…",
    "chat_templates.loading": "Loading templates…",
    "chat_templates.empty": "No templates yet. Make one in Studio → Documents.",
    "chat_templates.no_match": "No template matches your search.",
    "chat_templates.load_error": "Your templates could not be loaded.",
    "chat_templates.fill_message": "Fill in the template “{name}” with me. (template {id})",
    "chat_templates.type_presentation": "Presentation",
    "chat_templates.type_document": "Document",
    "chat_templates.card_progress": "{filled} of {total} fields filled in",
    "chat_templates.card_missing": "Still needed: {fields}",
    "chat_templates.card_ready": "Ready to download",
    "chat_templates.card_download_pdf": "Download PDF",
    "chat_templates.card_download_pptx": "Download PowerPoint",
    "chat_templates.card_open": "Open in Documents",
    "chat_templates.card_download_failed": "The download failed. Try again.",
};
