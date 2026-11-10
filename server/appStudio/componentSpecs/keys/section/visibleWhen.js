'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'boolean | {kind:"formula", expr}',
    description: 'Shows the section only while a condition holds, like node.visibleWhen. '
        + 'A hidden section renders nothing in the running app. When the formula reads only vars, forms, currentUser, screen, now or today, '
        + 'the data of the components inside it is not loaded either, so prefer such a condition for a section that holds heavy grids or charts. '
        + 'Example: {kind:"formula", expr:"vars.tab == \'archive\'"}. Set it with app_update_section {sectionId, visibleWhen}; null removes it. '
        + 'The editor shows a hidden section dimmed so it stays selectable.',
};
