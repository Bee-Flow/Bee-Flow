'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'string ≤120',
    description: 'One line of plain text under every screen of the app, e.g. a department and a phone number. Not on a public page. '
        + 'Set it with app_set_shell { footerText: "…" }; an empty string or null removes it.',
};
