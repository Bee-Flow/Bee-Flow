'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'string ≤60',
    description: 'A label for the section that only the builders see, never the viewer. '
        + 'The editor shows it on the section chip and in the section inspector, so an author can tell "Filters" from "Results" without reading the components. '
        + 'Set it with app_update_section {sectionId, name}; an empty string or null removes it. Use title for a heading the viewer reads.',
};
