// @typecheck strict
// English GUI defaults — namespace "studio_apps_fieldtypes": every key whose part before the first "." is "studio_apps_fieldtypes".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_fieldtypes.json. App Studio field types and display: the autonumber, JSON and person types,
// the kind of text a text field holds, and how a number or a date is meant to be shown, in the table editor.
module.exports = {
    "studio_apps_fieldtypes.type_autonumber": "Auto number",
    "studio_apps_fieldtypes.type_json": "JSON",
    "studio_apps_fieldtypes.type_user": "Person",
    "studio_apps_fieldtypes.autonumber_hint": "Numbered by the app: 1, 2, 3 … in the order records are created. Rows that already exist are numbered when you save.",
    "studio_apps_fieldtypes.json_hint": "Holds a JSON value. Text saved in this field must be valid JSON.",
    "studio_apps_fieldtypes.user_hint": "Holds the user id of a member of the organisation.",
    "studio_apps_fieldtypes.format": "Kind of text",
    "studio_apps_fieldtypes.format_none": "Any text",
    "studio_apps_fieldtypes.format_email": "E-mail address",
    "studio_apps_fieldtypes.format_url": "Web address",
    "studio_apps_fieldtypes.format_phone": "Phone number",
    "studio_apps_fieldtypes.format_hint": "Every value saved in this field is checked.",
    "studio_apps_fieldtypes.display_heading": "Display",
    "studio_apps_fieldtypes.display_hint": "Saved with the field to say how its value is meant to be shown. Grids and tables do not apply it yet, and the stored value never changes.",
    "studio_apps_fieldtypes.currency": "Currency",
    "studio_apps_fieldtypes.currency_none": "None",
    "studio_apps_fieldtypes.decimals": "Decimals",
    "studio_apps_fieldtypes.unit": "Unit",
    "studio_apps_fieldtypes.unit_placeholder": "kg",
    "studio_apps_fieldtypes.date_style": "Date style",
    "studio_apps_fieldtypes.date_default": "Default",
    "studio_apps_fieldtypes.date_short": "Short",
    "studio_apps_fieldtypes.date_medium": "Medium",
    "studio_apps_fieldtypes.date_long": "Long",
    "studio_apps_fieldtypes.date_full": "Full, with the weekday",
};
