// @typecheck strict
'use strict';

/**
 * Knob group "placement": where a node sits in its grid beyond the desktop `span`.
 *
 * Rides with `span`, so every type that has a grid cell earns it. Nothing here has a default
 * that is written: an absent knob is the behaviour every app had before (the automatic tablet
 * rule, the phone stack, one row, stretched, not sticky). The web draws the group in
 * agent-hub/.../runtime/styleKnobs/placement.ts with the rules at the end of css/layout.css;
 * validate/layoutChecks.mts warns where a value cannot work.
 */
module.exports = {
    since: 3,
    grantedBy: 'span',
    knobs: {
        spanMd: {
            type: 'int', min: 1, max: 12, step: 1, since: 3,
            description: 'Width in columns on tablet-sized screens (640 to 1023 px wide). '
                + 'Absent: the automatic rule applies there (a span of 1-4 becomes half the row, 5-11 the full row), '
                + 'or the node keeps its span when the grid sets columns or responsive "manual". '
                + 'Counted in the columns of the parent grid, a value at or above that count is the full row.',
        },
        spanSm: {
            type: 'int', min: 1, max: 12, step: 1, since: 3,
            description: 'Width in columns on phones (narrower than 640 px). '
                + 'Absent: the node takes the full row, the phone stack every app has. '
                + 'Setting it on one child makes that grid keep its columns on a phone, and the children without spanSm still take a full row each. '
                + 'Use it for small things that fit side by side on a phone: two stats (6 and 6), an icon button beside a field (2 and 10).',
        },
        rowSpan: {
            type: 'int', min: 1, max: 6, step: 1, since: 3,
            description: 'How many grid rows the node covers. '
                + 'For a tall node beside shorter ones: a span-8 chart with rowSpan 2 next to two span-4 stats puts the stats above each other beside the chart. '
                + 'Does not work as a direct child of a section or container with height "fill", and is ignored where the grid stacks on a phone.',
        },
        alignSelf: {
            type: 'enum', values: ['stretch', 'start', 'center', 'end'], default: 'stretch', since: 3,
            description: 'Vertical position of the node inside its grid row. '
                + 'stretch (the default) fills the height of the row, so cards in one row end at the same line. '
                + 'start, center and end keep the node at its own height at the top, middle or bottom of the row.',
        },
        sticky: {
            type: 'enum', values: ['none', 'top', 'bottom'], default: 'none', since: 3,
            description: 'Keeps the node in view while the page scrolls past its row. '
                + 'It moves only inside its own grid row(s), so put it beside taller content: a span-4 summary card with sticky "top" next to a long span-8 form follows the scroll. '
                + 'Alone in a row it has nowhere to move. Not for a node inside a card, container or section with a fixed height (that box scrolls by itself). Off in the editor canvas.',
        },
        stickyOffset: {
            type: 'int', min: 0, max: 6, step: 1, since: 3,
            description: 'Distance a sticky node keeps from the edge, in spacing steps. '
                + 'Only read when sticky is "top" or "bottom". 0 (the default) sticks flush to the edge of the scrolling area.',
        },
    },
};
