// @typecheck strict
// English GUI defaults — namespace "studio_apps_ui_steps": every key whose part before the first "." is "studio_apps_ui_steps".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_ui_steps.json. App Studio browser steps added in schema 3 (set_form_field, focus,
// scroll_to, copy_to_clipboard, set_ui, back, wait): their palette entries, the component picker and the
// runtime message of a refused clipboard write.
module.exports = {
    "studio_apps_ui_steps.catalog.back_blurb": "Return to the screen the person came from.",
    "studio_apps_ui_steps.catalog.back_label": "Go back",
    "studio_apps_ui_steps.catalog.copy_to_clipboard_blurb": "Copy a text, such as a reference or a link, to the person’s clipboard.",
    "studio_apps_ui_steps.catalog.copy_to_clipboard_label": "Copy to clipboard",
    "studio_apps_ui_steps.catalog.focus_blurb": "Move the keyboard focus to a component, so the person can type straight on.",
    "studio_apps_ui_steps.catalog.focus_label": "Put the cursor in a field",
    "studio_apps_ui_steps.catalog.scroll_to_blurb": "Bring a component into view, or go back to the top of the screen.",
    "studio_apps_ui_steps.catalog.scroll_to_label": "Scroll to",
    "studio_apps_ui_steps.catalog.set_form_field_blurb": "Put a value into one field of a form, as if it was typed.",
    "studio_apps_ui_steps.catalog.set_form_field_label": "Fill in a field",
    "studio_apps_ui_steps.catalog.set_ui_blurb": "Choose the open tab, open or close a dialog, or set the selected rows of a grid.",
    "studio_apps_ui_steps.catalog.set_ui_label": "Switch a tab or dialog",
    "studio_apps_ui_steps.catalog.wait_blurb": "Pause for a few seconds before the next step (at most 30).",
    "studio_apps_ui_steps.catalog.wait_label": "Wait a moment",
    "studio_apps_ui_steps.fields.node": "Component",
    "studio_apps_ui_steps.refs.empty_node": "No component fits this step yet: add one to a screen first.",
    "studio_apps_ui_steps.refs.pick_node": "Pick a component…",
    "studio_apps_ui_steps.refs.top": "Top of the screen",
    "studio_apps_ui_steps.runtime.copy_failed": "The text could not be copied to the clipboard.",
};
