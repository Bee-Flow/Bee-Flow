'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'boolean',
    description: 'Lets the viewer fold the section away by clicking its title. '
        + 'true starts the section open with a chevron next to the title; it does nothing without a title. '
        + 'Good for secondary detail (history, notes, advanced filters) under the main content. '
        + 'Set it with app_update_section {sectionId, collapsible: true}; false or null removes it.',
};
