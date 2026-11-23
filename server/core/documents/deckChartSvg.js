// @typecheck
/**
 * A chart as an inline SVG string — for the PDF deck (Chromium renders it)
 * and for any preview that wants the same picture without a chart library.
 *
 * Reads the chart model deckChart.chartFromAny produces and a RESOLVED deck
 * theme (chartColors, text, muted, tableLine, fontStack). Column, bar, line,
 * area, pie and donut; clustered or stacked; value labels; a legend when
 * there is more than one series. Every string is escaped; there are no
 * external references, no scripts, no fonts beyond the theme's stack.
 *
 * Pure: no I/O, no dependencies.
 */

const { readableOn, mix: mixHex } = require('./deckThemeOptions');

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

function seriesExtent(chart) {
    let min = 0; let max = 0;
    if (chart.stacked) {
        chart.labels.forEach((_, i) => {
            let pos = 0; let neg = 0;
            for (const s of chart.series) { const v = s.values[i]; if (typeof v === 'number') { if (v >= 0) pos += v; else neg += v; } }
            max = Math.max(max, pos); min = Math.min(min, neg);
        });
    } else {
        for (const s of chart.series) for (const v of s.values) if (typeof v === 'number') { max = Math.max(max, v); min = Math.min(min, v); }
    }
    return { min, max };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 */
const LEGEND_ROW = 18;

/**
 * Where each legend item goes: left to right, wrapping to a new row BEFORE
 * an item that would run past `width`.
 * @param {number} width
 * @returns {{ items: { x: number, row: number, label: string }[], rows: number }}
 */
function legendLayout(chart, width) {
    if (chart.series.length < 2) return { items: [], rows: 0 };
    const items = [];
    let cx = 0; let row = 0;
    chart.series.forEach((s, i) => {
        const label = fitLabel(s.name || `Series ${i + 1}`, Math.max(40, width - 35));
        const w = 18 + label.length * 7 + 18;
        if (cx > 0 && cx + w - 18 > width) { cx = 0; row += 1; }
        items.push({ x: cx, row, label });
        cx += w;
    });
    return { items, rows: row + 1 };
}

/**
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

/**
 * @param {{ min: number; max: number; ticks: number[]; }} scale
 * @param {{ x: number; y: number; w: number; h: number; }} plot
 * @param {boolean} horizontal
 */
function axesSvg(scale, plot, th, horizontal) {
    /** @type {string[]} */
    const parts = [];
    for (const t of scale.ticks) {
        if (horizontal) {
            const x = plot.x + ((t - scale.min) / (scale.max - scale.min)) * plot.w;
            parts.push(`<line x1="${x.toFixed(1)}" y1="${plot.y}" x2="${x.toFixed(1)}" y2="${plot.y + plot.h}" stroke="${th.grid}" stroke-width="1"/>`);
            parts.push(`<text x="${x.toFixed(1)}" y="${plot.y + plot.h + 16}" font-size="11" text-anchor="middle" fill="${th.muted}">${esc(fmt(t))}</text>`);
        } else {
            const y = plot.y + plot.h - ((t - scale.min) / (scale.max - scale.min)) * plot.h;
            parts.push(`<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${plot.x + plot.w}" y2="${y.toFixed(1)}" stroke="${th.grid}" stroke-width="1"/>`);
            parts.push(`<text x="${plot.x - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${th.muted}">${esc(fmt(t))}</text>`);
        }
    }
    return parts.join('');
}

/**
 * @param {{ x: number; y: number; w: number; h: number; }} plot
 * @param {{ min: number; max: number; ticks: number[]; }} scale
 * @param {boolean} horizontal
 */
function columnSvg(chart, th, plot, scale, horizontal) {
    const n = chart.labels.length;
    const k = chart.stacked ? 1 : chart.series.length;
    /** @type {string[]} */
    const parts = [];
    const range = scale.max - scale.min || 1;
    const slot = (horizontal ? plot.h : plot.w) / n;
    // Thin marks: never fill the slot, cap the bar, leave the band's rest as air.
    const gap = 3;
    const barW = Math.min(44, Math.max(6, (slot * 0.6 - gap * (k - 1)) / k));
    const groupW = barW * k + gap * (k - 1);
    /**
     * @param {number} v
     */
    const posOf = (v) => (v - scale.min) / range;
    const sparse = n * chart.series.length <= 12;
    const showValues = chart.showValues && sparse;
    // A bar with a 4px rounded data end and a square baseline end.
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} bw
     * @param {number} bh
     * @param {boolean} up
     */
    const barPath = (x, y, bw, bh, up) => {
        const r = Math.min(4, bw / 2, bh);
        if (horizontal) {
            // grows to the right (up=true) or left
            return up
                ? `M${x} ${y} H${x + bw - r} A${r} ${r} 0 0 1 ${x + bw} ${y + r} V${y + bh - r} A${r} ${r} 0 0 1 ${x + bw - r} ${y + bh} H${x} Z`
                : `M${x + bw} ${y} H${x + r} A${r} ${r} 0 0 0 ${x} ${y + r} V${y + bh - r} A${r} ${r} 0 0 0 ${x + r} ${y + bh} H${x + bw} Z`;
        }
        return up
            ? `M${x} ${y + bh} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} H${x + bw - r} A${r} ${r} 0 0 1 ${x + bw} ${y + r} V${y + bh} Z`
            : `M${x} ${y} V${y + bh - r} A${r} ${r} 0 0 0 ${x + r} ${y + bh} H${x + bw - r} A${r} ${r} 0 0 0 ${x + bw} ${y + bh - r} V${y} Z`;
    };
    chart.labels.forEach((label, i) => {
        let stackPos = 0; let stackNeg = 0;
        chart.series.forEach((s, si) => {
            const v = s.values[i];
            if (typeof v !== 'number') return;
            const colour = th.chartColors[si % th.chartColors.length];
            /** @type {number} */
            let from; let /** @type {number} */ to;
            if (chart.stacked) {
                if (v >= 0) { from = stackPos; stackPos += v; to = stackPos; } else { to = stackNeg; stackNeg += v; from = stackNeg; }
            } else { from = Math.min(0, v); to = Math.max(0, v); }
            const a = posOf(from); const b = posOf(to);
            // In a stack, a 2px surface gap parts the segments.
            const stroke = chart.stacked ? ` stroke="${th.background}" stroke-width="2"` : '';
            if (horizontal) {
                const y = plot.y + i * slot + (slot - groupW) / 2 + (chart.stacked ? 0 : si * (barW + gap));
                const x = plot.x + a * plot.w;
                const w = Math.max(0.5, (b - a) * plot.w);
                const capped = !chart.stacked || si === chart.series.length - 1;
                parts.push(capped ? `<path d="${barPath(Number(x.toFixed(1)), Number(y.toFixed(1)), Number(w.toFixed(1)), Number(barW.toFixed(1)), v >= 0)}" fill="${colour}"${stroke}/>` : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barW.toFixed(1)}" fill="${colour}"${stroke}/>`);
                if (showValues && !chart.stacked) parts.push(`<text x="${(x + w + 5).toFixed(1)}" y="${(y + barW / 2 + 4).toFixed(1)}" font-size="11" fill="${th.text}">${esc(fmt(v, chart.unit))}</text>`);
            } else {
                const x = plot.x + i * slot + (slot - groupW) / 2 + (chart.stacked ? 0 : si * (barW + gap));
                const yTop = plot.y + plot.h - b * plot.h;
                const h = Math.max(0.5, (b - a) * plot.h);
                const capped = !chart.stacked || si === chart.series.length - 1;
                parts.push(capped ? `<path d="${barPath(Number(x.toFixed(1)), Number(yTop.toFixed(1)), Number(barW.toFixed(1)), Number(h.toFixed(1)), v >= 0)}" fill="${colour}"${stroke}/>` : `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colour}"${stroke}/>`);
                if (showValues && !chart.stacked) {
                    // A negative bar's label goes below its end, or inside it
                    // when that would reach the category labels.
                    const inside = v < 0 && yTop + h + 13 > plot.y + plot.h - 2 && h > 18;
                    const ly = v >= 0 ? yTop - 6 : (inside ? yTop + h - 6 : Math.min(yTop + h + 13, plot.y + plot.h - 2));
                    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${ly.toFixed(1)}" font-size="11" text-anchor="middle" fill="${inside ? readableOn(colour, null, 3) : th.text}">${esc(fmt(v, chart.unit))}</text>`);
                }
            }
        });
        if (chart.stacked && showValues) {
            const total = chart.series.reduce((acc, s) => acc + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0);
            if (horizontal) parts.push(`<text x="${(plot.x + posOf(Math.max(0, total)) * plot.w + 5).toFixed(1)}" y="${(plot.y + i * slot + slot / 2 + 4).toFixed(1)}" font-size="11" fill="${th.text}">${esc(fmt(total, chart.unit))}</text>`);
            else parts.push(`<text x="${(plot.x + i * slot + slot / 2).toFixed(1)}" y="${(plot.y + plot.h - posOf(Math.max(0, total)) * plot.h - 5).toFixed(1)}" font-size="11" text-anchor="middle" fill="${th.text}">${esc(fmt(total, chart.unit))}</text>`);
        }
        // Category label (horizontal: clipped to the gutter)
        if (horizontal) parts.push(`<text x="${plot.x - 8}" y="${(plot.y + i * slot + slot / 2 + 4).toFixed(1)}" font-size="12" text-anchor="end" fill="${th.text}">${esc(fitLabel(label, plot.x - 16))}</text>`);
    });
    if (!horizontal) {
        for (const { i, text } of axisLabels(chart.labels, slot)) {
            parts.push(`<text x="${(plot.x + i * slot + slot / 2).toFixed(1)}" y="${plot.y + plot.h + 18}" font-size="12" text-anchor="middle" fill="${th.text}">${esc(text)}</text>`);
        }
    }
    return parts.join('');
}

/**
 * @param {{ x: number; y: number; w: number; h: number; }} plot
 * @param {{ min: number; max: number; ticks: number[]; }} scale
 * @param {boolean} area
 */
function lineSvg(chart, th, plot, scale, area) {
    const n = chart.labels.length;
    const range = scale.max - scale.min || 1;
    const stepX = n > 1 ? plot.w / (n - 1) : 0;
    const xAt = (i) => plot.x + (n > 1 ? i * stepX : plot.w / 2);
    /**
     * @param {number} v
     */
    const yAt = (v) => plot.y + plot.h - ((v - scale.min) / range) * plot.h;
    const zeroY = yAt(0);
    /** @type {string[]} */
    const parts = [];
    const stackBase = new Array(n).fill(0);
    // Unstacked areas: the biggest series goes to the back so none is hidden.
    const order = area && !chart.stacked && chart.series.length > 1
        ? chart.series.map((s, i) => ({ i, peak: Math.max(...s.values.filter((v) => typeof v === 'number'), 0) })).sort((a, b) => b.peak - a.peak).map((x) => x.i)
        : chart.series.map((_, i) => i);
    order.forEach((si) => {
        const s = chart.series[si];
        const colour = th.chartColors[si % th.chartColors.length];
        /** @type {{ x: number; y: number; v: number; base: number; }[]} */
        const pts = [];
        // A gap (null) breaks the line: each run of points is its own path.
        /** @type {{ x: number; y: number; v: number; base: number; }[][]} */
        const runs = [[]];
        s.values.forEach((v, i) => {
            if (typeof v !== 'number') { if (runs[runs.length - 1].length) runs.push([]); return; }
            const val = chart.stacked && area ? stackBase[i] + v : v;
            const p = { x: xAt(i), y: yAt(val), v, base: chart.stacked && area ? yAt(stackBase[i]) : zeroY };
            pts.push(p);
            runs[runs.length - 1].push(p);
            if (chart.stacked && area) stackBase[i] += v;
        });
        if (!pts.length) return;
        for (const run of runs.filter((r) => r.length)) {
            const d = run.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
            if (area) {
                const back = run.slice().reverse().map((p) => `L${p.x.toFixed(1)} ${p.base.toFixed(1)}`).join(' ');
                parts.push(`<path d="${d} ${back} Z" fill="${colour}" fill-opacity="${chart.stacked ? 0.55 : 0.16}" stroke="none"/>`);
            }
            if (run.length > 1) parts.push(`<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        }
        // Markers with a surface ring; values only where they stay sparse,
        // otherwise just the endpoint.
        const sparse = n * chart.series.length <= 12;
        pts.forEach((p, i) => {
            parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${colour}" stroke="${th.background}" stroke-width="2"/>`);
            if (chart.showValues && (sparse || i === pts.length - 1)) parts.push(`<text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" font-size="11" text-anchor="middle" fill="${th.text}">${esc(fmt(p.v, chart.unit))}</text>`);
        });
    });
    for (const { i, text } of axisLabels(chart.labels, n > 1 ? stepX : plot.w)) {
        parts.push(`<text x="${xAt(i).toFixed(1)}" y="${plot.y + plot.h + 18}" font-size="12" text-anchor="middle" fill="${th.text}">${esc(text)}</text>`);
    }
    return parts.join('');
}

/**
 * @param {{ x: number; y: number; w: number; h: number; }} box
 * @param {boolean} donut
 */
function pieSvg(chart, th, box, donut) {
    const values = chart.series[0].values.map((v) => (typeof v === 'number' && v > 0 ? v : 0));
    const total = values.reduce((a, b) => a + b, 0);
    /** @type {string[]} */
    const parts = [];
    if (!total) return `<text x="${box.x + box.w / 2}" y="${box.y + box.h / 2}" text-anchor="middle" font-size="13" fill="${th.muted}">—</text>`;
    const r = Math.min(box.w, box.h) / 2 - 8;
    const cx = box.x + r + 8; const cy = box.y + box.h / 2;
    const inner = donut ? Number((r * 0.55).toFixed(2)) : 0;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
        if (!v) return;
        const frac = v / total;
        const a1 = angle; const a2 = angle + frac * 2 * Math.PI;
        angle = a2;
        const large = frac > 0.5 ? 1 : 0;
        const colour = th.chartColors[i % th.chartColors.length];
        /**
         * @param {number} a
         * @param {number} rad
         */
        const p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
        /** @type {string} */
        let d;
        if (frac >= 0.9999) {
            d = donut
                ? `M${p(a1, r)} A${r} ${r} 0 1 1 ${p(a1 + Math.PI, r)} A${r} ${r} 0 1 1 ${p(a1, r)} M${p(a1, inner)} A${inner} ${inner} 0 1 0 ${p(a1 + Math.PI, inner)} A${inner} ${inner} 0 1 0 ${p(a1, inner)}`
                : `M${p(a1, r)} A${r} ${r} 0 1 1 ${p(a1 + Math.PI, r)} A${r} ${r} 0 1 1 ${p(a1, r)}`;
            parts.push(`<path d="${d}" fill="${colour}" fill-rule="evenodd"/>`);
        } else {
            d = donut
                ? `M${p(a1, r)} A${r} ${r} 0 ${large} 1 ${p(a2, r)} L${p(a2, inner)} A${inner} ${inner} 0 ${large} 0 ${p(a1, inner)} Z`
                : `M${cx} ${cy} L${p(a1, r)} A${r} ${r} 0 ${large} 1 ${p(a2, r)} Z`;
            parts.push(`<path d="${d}" fill="${colour}" stroke="${th.background}" stroke-width="1.5"/>`);
        }
        if (chart.showValues && frac >= 0.04) {
            const mid = (a1 + a2) / 2;
            const lr = donut ? (r + inner) / 2 : r * 0.62;
            const lx = cx + lr * Math.cos(mid); const ly = cy + lr * Math.sin(mid);
            const fill = readableOn(colour, null, 3);
            parts.push(`<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" font-size="12" font-weight="600" text-anchor="middle" fill="${fill}">${Math.round(frac * 100)}%</text>`);
        }
    });
    // Labels as a list to the right of the pie
    const lx = cx + r + 24;
    const lineH = Math.min(22, box.h / Math.max(1, chart.labels.length));
    let ly = cy - (chart.labels.length * lineH) / 2 + lineH / 2;
    chart.labels.forEach((label, i) => {
        if (lx + 20 > box.x + box.w) return;
        parts.push(`<rect x="${lx}" y="${(ly - 6).toFixed(1)}" width="12" height="12" rx="2" fill="${th.chartColors[i % th.chartColors.length]}"/>`);
        parts.push(`<text x="${lx + 18}" y="${(ly + 4).toFixed(1)}" font-size="12" fill="${th.text}">${esc(fitLabel(label, box.x + box.w - lx - 18 - (values[i] ? 60 : 0)))}${values[i] ? ` <tspan fill="${th.muted}">${esc(fmt(values[i], chart.unit))}</tspan>` : ''}</text>`);
        ly += lineH;
    });
    return parts.join('');
}

/**
 * @param {import('./deckModel').SlideChart | null | undefined} chart  deckChart model
 * @param {{ chartColors?: string[], text?: string | null, muted?: string | null, tableLine?: string | null,
 *   background?: string | null, onAccent?: string | null, fontStack?: string | null }} th     resolved deck theme
 * @param {{width?:number, height?:number}} [size]
 * @returns {string} an <svg> element
 */
function chartSvg(chart, th, { width = 900, height = 480 } = {}) {
    if (!chart || !Array.isArray(chart.series) || !chart.series.length) return '';
    const theme = {
        chartColors: Array.isArray(th.chartColors) && th.chartColors.length ? th.chartColors : ['#123A5E', '#4A6C8A', '#E0A23C', '#8DB3D1', '#5E8F3A', '#8A8D91'],
        text: th.text || '#1A1D21', muted: th.muted || '#5B6167', tableLine: th.tableLine || '#D9DBDE', background: th.background || '#FFFFFF',
        grid: th.tableLine ? mixHex(th.background || '#FFFFFF', th.text || '#1A1D21', 0.1) : '#ECEDEE',
        onAccent: th.onAccent || '#FFFFFF', fontStack: th.fontStack || 'Calibri, Carlito, Helvetica, Arial, sans-serif',
    };
    /** @type {string[]} */
    const parts = [];
    const titleH = chart.title ? 26 : 0;
    if (chart.title) parts.push(`<text x="${width / 2}" y="18" font-size="15" font-weight="600" text-anchor="middle" fill="${theme.text}">${esc(chart.title)}</text>`);
    const type = chart.type;
    if (type === 'pie' || type === 'donut') {
        parts.push(pieSvg(chart, theme, { x: 20, y: titleH + 10, w: width - 40, h: height - titleH - 20 }, type === 'donut'));
    } else {
        const horizontal = type === 'bar';
        const longest = Math.max(...chart.labels.map((l) => String(l).length), 1);
        const plotX = horizontal ? Math.min(220, 20 + longest * 7) : 56;
        const plotW = width - plotX - 24;
        // Room for every row the legend wraps into.
        const legendRows = legendLayout(chart, plotW).rows;
        const legendH = legendRows ? 24 + (legendRows - 1) * LEGEND_ROW : 0;
        const plot = {
            x: plotX,
            y: titleH + 14 + (chart.unit && type !== 'bar' ? 14 : 0),
            w: plotW,
            h: height - titleH - 14 - 30 - legendH,
        };
        const ext = seriesExtent(chart);
        // Headroom for the value labels on the tallest marks.
        const scale = niceScale(ext.min < 0 ? ext.min * 1.08 : ext.min, ext.max > 0 ? ext.max * 1.08 : ext.max);
        parts.push(axesSvg(scale, plot, theme, horizontal));
        if (type === 'line' || type === 'area') parts.push(lineSvg(chart, theme, plot, scale, type === 'area'));
        else parts.push(columnSvg(chart, theme, plot, scale, horizontal));
        if (chart.unit && !horizontal) parts.push(`<text x="${plot.x - 8}" y="${plot.y - 12}" font-size="11" text-anchor="end" fill="${theme.muted}">${esc(chart.unit)}</text>`);
        parts.push(legendSvg(chart, theme, plot.x, height - 6, plot.w));
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" font-family="${esc(theme.fontStack)}">${parts.join('')}</svg>`;
}

module.exports = { chartSvg, _test: { niceScale, fmt, fitLabel, axisLabels, legendLayout } };

/**
 * @typedef {import('./deckModel').SlideChart} Chart
 * @typedef {{ chartColors: string[], text: string, muted: string, tableLine: string, background: string, grid: string,
 *   onAccent: string, fontStack: string }} ChartTheme
 */
