/**
 * Knob group "placement" (server: componentSpecs/styleKnobGroups/placement.js): a node's
 * tablet and phone width, its row span, its position in the row and whether it sticks.
 * The rules its classes select are at the end of css/layout.css.
 */
import type { StyleKnobHandler } from '../styleKnobHandlers';
import { applyPlacement } from '../styleResolver/layout';

const placement: StyleKnobHandler = {
    labels: {
        spanMd: ['studio_apps_layout.knobs.span_md', 'Width on tablet'],
        spanSm: ['studio_apps_layout.knobs.span_sm', 'Width on phone'],
        rowSpan: ['studio_apps_layout.knobs.row_span', 'Rows'],
        alignSelf: ['studio_apps_layout.knobs.align_self', 'Position in row'],
        sticky: ['studio_apps_layout.knobs.sticky', 'Stick while scrolling'],
        stickyOffset: ['studio_apps_layout.knobs.sticky_offset', 'Distance from edge'],
    },
    node: (s, style) => applyPlacement(s, style),
};

export default placement;
