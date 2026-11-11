'use strict';
// @typecheck strict

/** A theme override of one section (canonicalize/scopeTheme.mts, package LK16). */
module.exports = {
    since: 3,
    shape: '{ primary?, accent?, radius?, density?, fontScale?, appearance? }',
    description: 'A theme of this section that differs from the screen\'s theme. '
        + 'An object with any of the app theme keys but canvas (primary and accent as #rrggbb, radius, density, fontScale, appearance), only the ones that should differ. '
        + 'It applies inside the section only: a band in the brand\'s second colour { primary: "#b45309" }, a compact table area { density: "compact" }, or a dark hero { appearance: "dark" }, which also paints the section\'s ground in that appearance so its text stays readable. '
        + 'Set it with app_update_section { sectionId, theme: { … } } (the object replaces the one there), null removes it.',
};
