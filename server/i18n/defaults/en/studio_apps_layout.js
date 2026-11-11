// @typecheck strict
// English GUI defaults — namespace "studio_apps_layout": every key whose part before the first "." is "studio_apps_layout".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_layout.json. App Studio layout: a grid's column count, a block's width per screen size,
// row span, position in the row and sticky (the inspector's Layout block and the canvas screen-size switch).
module.exports = {
    "studio_apps_layout.breakpoint.hint": "Which screen size the widths you drag are for. Preview shows the real result.",
    "studio_apps_layout.breakpoint.label": "Arrange widths for",
    "studio_apps_layout.breakpoint.lg": "Desktop",
    "studio_apps_layout.breakpoint.md": "Tablet",
    "studio_apps_layout.breakpoint.sm": "Phone",
    "studio_apps_layout.hints.columns": "1 to 12. Empty: the standard 12 columns.",
    "studio_apps_layout.hints.responsive": "Rearrange: narrow blocks become half the row on a tablet, wide ones the full row. Keep: every block keeps its width.",
    "studio_apps_layout.hints.responsive_columns": "A grid with its own column count is never rearranged. Give a block a tablet width where it needs one.",
    "studio_apps_layout.hints.span_md": "Columns between 640 and 1023 px wide. Empty: decided by the grid.",
    "studio_apps_layout.hints.span_sm": "Columns below 640 px wide. Empty: the block takes the full width, like every block on a phone.",
    "studio_apps_layout.hints.sticky": "The block stays in view next to taller content in the same row. Not shown while editing: use Preview.",
    "studio_apps_layout.knobs.align_self": "Position in row",
    "studio_apps_layout.knobs.columns": "Columns",
    "studio_apps_layout.knobs.responsive": "On tablet",
    "studio_apps_layout.knobs.row_span": "Rows",
    "studio_apps_layout.knobs.span_md": "Width on tablet",
    "studio_apps_layout.knobs.span_sm": "Width on phone",
    "studio_apps_layout.knobs.sticky": "Stick while scrolling",
    "studio_apps_layout.knobs.sticky_offset": "Distance from edge",
    "studio_apps_layout.section.hint_grid": "Columns, tablet and phone",
    "studio_apps_layout.section.hint_node": "Tablet and phone width, rows, sticky",
    "studio_apps_layout.section.title": "Layout",
    "studio_apps_layout.values.automatic": "Automatic",
    "studio_apps_layout.values.bottom": "Bottom",
    "studio_apps_layout.values.full_width": "Full width",
    "studio_apps_layout.values.middle": "Middle",
    "studio_apps_layout.values.responsive_auto": "Rearrange",
    "studio_apps_layout.values.responsive_manual": "Keep",
    "studio_apps_layout.values.sticky_none": "Off",
    "studio_apps_layout.values.stretch": "Fill",
    "studio_apps_layout.values.top": "Top",
};
