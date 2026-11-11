/**
 * App Studio runtime: the "hover" knob group (server/appStudio/componentSpecs/styleKnobGroups/hover.js).
 *
 * A preset is a class on the node's grid cell; hover.css does the rest. 'none', an absent
 * knob and an unknown value add nothing.
 */

import './hover.css';
import type { StyleKnobHandler } from '../styleKnobHandlers';

export const HOVER_CLASSES: Readonly<Record<string, string>> = Object.freeze({
    lift: 'app-hover-lift',
    tint: 'app-hover-tint',
    outline: 'app-hover-outline',
    grow: 'app-hover-grow',
});

const hover: StyleKnobHandler = {
    title: ['studio_apps_hover.title', 'Hover'],
    labels: {
        hover: ['studio_apps_hover.knobs.hover', 'On hover'],
    },
    valueLabels: {
        hover: {
            none: ['studio_apps_hover.values.none', 'None'],
            lift: ['studio_apps_hover.values.lift', 'Lift'],
            tint: ['studio_apps_hover.values.tint', 'Tint'],
            outline: ['studio_apps_hover.values.outline', 'Outline'],
            grow: ['studio_apps_hover.values.grow', 'Grow'],
        },
    },
    node: (s) => (typeof s.hover === 'string' && Object.hasOwn(HOVER_CLASSES, s.hover) ? HOVER_CLASSES[s.hover] : ''),
};

export default hover;
