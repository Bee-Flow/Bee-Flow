/**
 * Knob group "grid_columns" (server: componentSpecs/styleKnobGroups/grid_columns.js): the
 * column count of a grid and whether the tablet tier may rearrange it.
 *
 * A section's grid is drawn here. A grid container draws its own inner grid (the cell this
 * resolver styles is not that grid), with gridColumnStyle and gridClasses of
 * styleResolver/layout.ts.
 */
import type { StyleKnobHandler } from '../styleKnobHandlers';
import { gridColumnStyle, gridOwnClasses } from '../styleResolver/layout';

const gridColumnsGroup: StyleKnobHandler = {
    labels: {
        columns: ['studio_apps_layout.knobs.columns', 'Columns'],
        responsive: ['studio_apps_layout.knobs.responsive', 'On tablet'],
    },
    section: (s, style) => {
        Object.assign(style, gridColumnStyle(s));
        return gridOwnClasses(s);
    },
};

export default gridColumnsGroup;
