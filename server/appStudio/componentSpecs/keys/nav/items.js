'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: '[{ id?, label ≤40, icon?, screenId | url }] ≤10',
    description: 'Links of the app\'s own, beside its screens. '
        + 'They are shown after the screens in the top bar, the sidebar and the phone menu. '
        + 'Each item names a screen of this app (screenId: a shortcut, also to a screen with showInNav false) or an address (url: http or https only), which opens in a new tab as a plain link. '
        + 'icon is a Lucide icon name. The id (nvi_…) is made for you. Not shown with style none, nor on a public page. '
        + 'Set the whole list with app_set_shell { items: [ { label: "Help", url: "https://example.org/help" } ] }; [] or null removes it.',
};
