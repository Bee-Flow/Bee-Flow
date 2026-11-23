// @typecheck strict
/**
 * The small pieces of deckChartSvg.js: escaping, number and label fitting,
 * the axis scale, and the legend layout. Split out to keep that file to one
 * job (drawing the chart types).
 *
 * Pure: no I/O, no dependencies.
 */

/**
 * @param {string} v
 */
function esc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {number} n
 * @param {string} [unit]
 */
function fmt(n, unit = '') {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    /** @type {string} */
    let s;
    // The largest tier whose rounded value stays below 1000 of the next one up.
    const tiers = [{ min: 1e9, div: 1e9, suf: 'B' }, { min: 1e6, div: 1e6, suf: 'M' }, { min: 1e4, div: 1e3, suf: 'k' }];
    const t = tiers.findIndex((x) => abs >= x.min);
    if (t !== -1) {
        let tier = tiers[t];
        let digits = tier.suf !== 'k' && abs < tier.min * 10 ? 1 : 0;
        if (t > 0 && Math.abs(Number((n / tier.div).toFixed(digits))) >= 1000) { tier = tiers[t - 1]; digits = 1; }
        s = `${(n / tier.div).toFixed(digits).replace(/\.0$/, '')}${tier.suf}`;
    } else s = Number.isInteger(n) ? String(n) : n.toFixed(abs < 10 ? 2 : 1).replace(/\.?0+$/, '');
    if (s === '-0') s = '0';
    return unit ? `${s}${unit === '%' ? '%' : ` ${unit}`}` : s;
}

/**
 * A label clipped with an ellipsis to roughly `px` pixels at 12px type.
 * @param {string} label
 * @param {number} px
 */
function fitLabel(label, px) {
    const s = String(label ?? '');
    const max = Math.max(1, Math.floor(px / 7));
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}

/**
 * Which category labels a horizontal axis shows: every one when the slots
 * are wide enough, otherwise every n-th, each clipped to its room.
 * @param {string[]} labels
 * @param {number} slot  pixels per category
 * @returns {{ i: number, text: string }[]}
 */
function axisLabels(labels, slot) {
    const longest = Math.max(1, ...labels.map((l) => String(l).length));
    const need = Math.min(longest, 6) * 7 + 6;
    const every = Math.max(1, Math.ceil(need / Math.max(1, slot)));
    return labels.map((l, i) => ({ i, text: fitLabel(l, slot * every - 6) })).filter((x) => x.i % every === 0);
}

/**
 * A "nice" axis maximum (and minimum when negatives exist) with ~5 ticks.
 * @param {number} min
 * @param {number} max
 */
function niceScale(min, max) {
    const lo = Math.min(0, min);
    const hi = Math.max(0, max);
    const span = hi - lo || 1;
    const raw = span / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const niceLo = Math.floor(lo / step) * step;
    // All-negative data ends at zero; no empty positive band.
    const niceHi = Math.ceil(hi / step) * step || (lo < 0 ? 0 : step);
    /** @type {number[]} */
    const ticks = [];
    for (let v = niceLo; v <= niceHi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
    return { min: niceLo, max: niceHi, ticks };
}

/**
 * @param {Chart} chart
 */
function seriesExtent(chart) {
    let min = 0; let max = 0;
    if (chart.stacked) {
        chart.labels.forEach((/** @type {unknown} */ _, /** @type {number} */ i) => {
            let pos = 0; let neg = 0;
            for (const s of chart.series) { const v = s.values[i]; if (typeof v === 'number') { if (v >= 0) pos += v; else neg += v; } }
            max = Math.max(max, pos); min = Math.min(min, neg);
        });
    } else {
        for (const s of chart.series) for (const v of s.values) if (typeof v === 'number') { max = Math.max(max, v); min = Math.min(min, v); }
    }
    return { min, max };
}

const LEGEND_ROW = 18;

/**
 * Where each legend item goes: left to right, wrapping to a new row BEFORE
 * an item that would run past `width`.
 * @param {Chart} chart
 * @param {number} width
 * @returns {{ items: { x: number, row: number, label: string }[], rows: number }}
 */
function legendLayout(chart, width) {
    if (chart.series.length < 2) return { items: [], rows: 0 };
    /** @type {{ x: number, row: number, label: string }[]} */
    const items = [];
    let cx = 0; let row = 0;
    chart.series.forEach((/** @type {{ name?: string }} */ s, /** @type {number} */ i) => {
        const label = fitLabel(s.name || `Series ${i + 1}`, Math.max(40, width - 35));
        const w = 18 + label.length * 7 + 18;
        if (cx > 0 && cx + w - 18 > width) { cx = 0; row += 1; }
        items.push({ x: cx, row, label });
        cx += w;
    });
    return { items, rows: row + 1 };
}

/**
 * @param {Chart} chart
 * @param {ChartTheme} th
 * @param {number} x
 * @param {number} y  baseline of the LAST row
 * @param {number} width
 */
function legendSvg(chart, th, x, y, width) {
    const { items, rows } = legendLayout(chart, width);
    const top = y - (rows - 1) * LEGEND_ROW;
    return items.map((it, i) => {
        const cx = x + it.x; const cy = top + it.row * LEGEND_ROW;
        return `<rect x="${cx}" y="${cy - 9}" width="12" height="12" rx="2" fill="${th.chartColors[i % th.chartColors.length]}"/><text x="${cx + 17}" y="${cy + 1}" font-size="12" fill="${th.muted}">${esc(it.label)}</text>`;
    }).join('');
}

module.exports = { esc, fmt, fitLabel, axisLabels, niceScale, seriesExtent, legendLayout, legendSvg, LEGEND_ROW };

/**
 * @typedef {import('./deckModel').SlideChart} Chart
 * @typedef {{ chartColors: string[], text: string, muted: string, tableLine: string, background: string, grid: string,
 *   onAccent: string, fontStack: string }} ChartTheme
 */
