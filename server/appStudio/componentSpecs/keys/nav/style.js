'use strict';
// @typecheck strict

module.exports = {
    valuesSince: { none: 3 },
    shape: 'tabs|sidebar|mega|rail|none',
    description: 'none draws no navigation at all: no top bar, no sidebar, no screen menu, no brand. '
        + 'For an app of one screen, or one shown inside another page. The viewer keeps a small menu in the corner (their account, back to all apps); other screens are reached only through navigate actions and nav.items. '
        + 'Set it with app_set_shell { style: "none" }.',
};
