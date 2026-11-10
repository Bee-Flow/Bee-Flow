// @typecheck strict
'use strict';

/**
 * Knob group "grid_columns": how many columns a grid has and whether the tablet tier may
 * rearrange it.
 *
 * Rides with `gap`, the knob every grid already has: the section, card, container, form, tab,
 * modal and repeater (the grid of each item). The other types that carry `gap` do not lay their
 * children out on this grid (GRID_TYPES in validate/layoutChecks.mts says which do), and the
 * validator warns when one of them sets these knobs. Absent means the 12-column grid with the
 * automatic tablet rule, which is what every app had before. The web reads the knobs in
 * agent-hub/.../runtime/styleResolver/layout.ts (gridTemplate, gridClasses).
 */
module.exports = {
    since: 3,
    grantedBy: 'gap',
    knobs: {
        columns: {
            type: 'int', min: 1, max: 12, step: 1, since: 3,
            description: 'Number of equal columns of this grid, 12 when absent. '
                + 'Works on a section, card, container, form, tab, modal and repeater (the grid of each item). '
                + 'The children still size themselves with span, counted in these columns: with columns 5 a span of 1 is a fifth of the row and a span of 5 or more is the full row. '
                + 'Below 12 it also turns off the automatic tablet rule for this grid, so give children a spanMd where a tablet needs another split. Phones still stack.',
        },
        responsive: {
            type: 'enum', values: ['auto', 'manual'], default: 'auto', since: 3,
            description: 'Whether tablet-sized screens may rearrange the children of this grid. '
                + 'auto (the default): between 640 and 1023 px a child with span 1-4 takes half the row and 5-11 the full row. '
                + 'manual: every child keeps its span there unless it sets spanMd. Works on the same types as columns. Phones still stack unless a child sets spanSm.',
        },
    },
};
