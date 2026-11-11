'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'string ≤80',
    description: 'A heading drawn at the top of the section, inside its padding. '
        + 'Use it to name a band of the screen ("Open orders", "This week") instead of a separate heading component. '
        + 'Set it with app_update_section {sectionId, title} or app_add_section {screenId, title}; an empty string or null removes it. '
        + 'A collapsible section needs a title: the title is what the viewer clicks.',
};
