/**
 * Chart chrome on platform tokens — what every chart in the product shares.
 *
 * Axes, grid and tooltip read the text/border/surface tokens so a chart is
 * at home in every theme; the SERIES read `--chart-1..8` (index.css), a
 * validated categorical palette with no purple, violet or indigo in it
 * (house rule, AppStudio.noPurple.test). App Studio's runtime keeps its own
 * hex palette for the app designer's brand colours and re-imports the chrome
 * from here, so the two never drift.
 */

export const CHART_AXIS = { fontSize: 11, stroke: 'var(--text-tertiary)' };
export const CHART_GRID_STROKE = 'var(--border-subtle)';
export const CHART_TOOLTIP_STYLE = {
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--text-primary)',
};

/** The eight series slots, as CSS variables — declared per theme in index.css. */
export const CHART_SERIES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8].map(n => `var(--chart-${n})`));

/** The nth series colour, wrapping. */
export function chartSeriesVar(index) {
    const n = CHART_SERIES.length;
    const i = Number.isFinite(index) ? ((Math.trunc(index) % n) + n) % n : 0;
    return CHART_SERIES[i];
}
