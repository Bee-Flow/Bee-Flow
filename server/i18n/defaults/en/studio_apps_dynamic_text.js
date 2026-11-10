// @typecheck strict
// English GUI defaults — namespace "studio_apps_dynamic_text": every key whose part before the first "." is "studio_apps_dynamic_text".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_dynamic_text.json. App Studio dynamic text: toast, confirm, navigate and open_url steps whose
// text, screen or address is a formula, a switch case picked by a formula, the owner's list of hosts a formula
// link may open, and the effects a sequence applies when it ends.
module.exports = {
    'studio_apps_dynamic_text.case_when_aria': 'Case {n} formula',
    'studio_apps_dynamic_text.case_when_placeholder': 'Or a formula, e.g. vars.total >= 100',
    'studio_apps_dynamic_text.cases_when_help': 'A case with a formula runs when the formula is true instead; use it for ranges.',
    'studio_apps_dynamic_text.effects_title': 'When it ends',
    'studio_apps_dynamic_text.field_cancel_label_expr': 'Cancel button (formula)',
    'studio_apps_dynamic_text.field_confirm_label_expr': 'Confirm button (formula)',
    'studio_apps_dynamic_text.field_message_expr': 'Message (formula)',
    'studio_apps_dynamic_text.field_screen_expr': 'Screen (formula)',
    'studio_apps_dynamic_text.field_title_expr': 'Title (formula)',
    'studio_apps_dynamic_text.field_url_expr': 'Address (formula)',
    'studio_apps_dynamic_text.hint_screen_expr': 'Gives the id of one of this app’s screens. Used instead of the screen above.',
    'studio_apps_dynamic_text.hint_text_expr': 'Used instead of the text above when it gives a result.',
    'studio_apps_dynamic_text.hint_url_expr': 'Opens only https addresses on the hosts listed in the app settings under “Links from formulas”.',
    'studio_apps_dynamic_text.hosts_hint': 'One host per line, for example example.com. An “open a web page” step that builds its address with a formula only opens https addresses on these hosts. Only you can change this list, the app builder cannot.',
    'studio_apps_dynamic_text.hosts_label': 'Hosts a link may open',
    'studio_apps_dynamic_text.hosts_refused': 'Left out: {hosts}. Write only the host name, for example example.com.',
    'studio_apps_dynamic_text.hosts_title': 'Links from formulas',
    'studio_apps_dynamic_text.screen_empty': 'The formula for the screen to open gave no screen.',
    'studio_apps_dynamic_text.screen_unknown': 'This step opens the screen “{screen}”, which is not part of this app.',
    'studio_apps_dynamic_text.url_empty': 'The formula for the address to open gave no address.',
    'studio_apps_dynamic_text.url_host_not_allowed': 'The address was not opened: its host “{host}” is not on the app’s list of allowed hosts.',
    'studio_apps_dynamic_text.url_invalid': 'The formula for the address to open did not give a web address.',
    'studio_apps_dynamic_text.url_not_https': 'Only plain https addresses can be opened from an app.',
};
