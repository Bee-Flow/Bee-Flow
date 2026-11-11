'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'bar|hidden',
    description: 'hidden draws no top bar: the screen starts at the top edge. '
        + 'With the tabs and mega styles the tab row goes with it; with sidebar and rail the sidebar stays and only the bar on phones goes. '
        + 'A small corner keeps the screen menu (when there is more than one screen) and the viewer\'s menu, so nobody is shut in. '
        + 'bar is the default. Set it with app_set_shell { header: "hidden" }.',
};
