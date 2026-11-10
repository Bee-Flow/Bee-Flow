/**
 * App Studio runtime: the "box" knob group (server/appStudio/componentSpecs/styleKnobGroups/box.js).
 *
 * Margins, shadow, opacity, a border per side and a fill, painted on the node's grid cell by
 * applyBoxKnobs (../styleResolver/box.ts). It runs after the base box, so backgroundColor wins
 * over `background` and a border of this group replaces the `border` knob. No CSS of its own:
 * the shadow values are the semantic --app-shadow tokens, which app-tokens.css already turns
 * into rings in high contrast.
 */

import { applyBoxKnobs } from '../styleResolver/box';
import type { StyleKnobHandler } from '../styleKnobHandlers';

const box: StyleKnobHandler = {
    title: ['studio_apps_box.title', 'Box'],
    labels: {
        marginTop: ['studio_apps_box.knobs.margin_top', 'Space above'],
        marginBottom: ['studio_apps_box.knobs.margin_bottom', 'Space below'],
        shadow: ['studio_apps_box.knobs.shadow', 'Shadow'],
        opacity: ['studio_apps_box.knobs.opacity', 'Opacity'],
        borderWidth: ['studio_apps_box.knobs.border_width', 'Border width'],
        borderSides: ['studio_apps_box.knobs.border_sides', 'Border sides'],
        borderColor: ['studio_apps_box.knobs.border_color', 'Border colour'],
        backgroundColor: ['studio_apps_box.knobs.background_color', 'Fill colour'],
    },
    valueLabels: {
        shadow: {
            none: ['studio_apps_box.values.none', 'None'],
            sm: ['studio_apps_box.values.small', 'Small'],
            md: ['studio_apps_box.values.medium', 'Medium'],
            lg: ['studio_apps_box.values.large', 'Large'],
        },
        borderSides: {
            all: ['studio_apps_box.values.all', 'All sides'],
            top: ['studio_apps_box.values.top', 'Top'],
            right: ['studio_apps_box.values.right', 'Right'],
            bottom: ['studio_apps_box.values.bottom', 'Bottom'],
            left: ['studio_apps_box.values.left', 'Left'],
            x: ['studio_apps_box.values.x', 'Left and right'],
            y: ['studio_apps_box.values.y', 'Top and bottom'],
        },
    },
    node: applyBoxKnobs,
};

export default box;
