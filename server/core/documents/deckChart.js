// @typecheck
/**
 * Deck visuals as data — the collectors behind a slide's `chart`, `stats` and
 * `steps` blocks.
 *
 * A chart on a slide arrives in whatever shape the author had at hand: the
 * rows a datatable step returned, a `{labels, series}` object, a matrix, a
 * markdown table, or the "Label: value" lines an AI wrote in a ```chart block.
 * `chartFromAny` turns every one of them into ONE shape both renderers read:
 *
 *     { type, labels:[…], series:[{ name, values:[number|null] }], stacked, showValues, unit, title }
 *
 * The auto-detection rule for rows is deliberately simple and stated once:
 * the first column whose values are mostly text becomes the labels, every
 * column whose values are mostly numbers becomes a series — unless the
 * author names them (`labels:"maand"`, `values:"omzet,kosten"`).
 *
 * Numbers are parsed the way people write them, not the way JSON does:
 * "1.554,25", "€ 12", "12%", "1,2M" all become numbers. A cell that is not
 * a number becomes null (a gap in the series), never NaN and never a throw —
 * a chart with one bad cell is still a chart.
 *
 * Pure: no I/O, no dependencies.
 */

const CHART_TYPES = Object.freeze(['column', 'bar', 'line', 'area', 'pie', 'donut']);
const CHART_TYPE_ALIASES = Object.freeze({
    col: 'column', columns: 'column', vertical: 'column', kolom: 'column', staaf: 'column',
    bars: 'bar', horizontal: 'bar', balk: 'bar',
    lines: 'line', lijn: 'line',
    areas: 'area', vlak: 'area',
    doughnut: 'donut', ring: 'donut',
    taart: 'pie', cirkel: 'pie',
});
const CHART_LIMITS = Object.freeze({ maxSeries: 8, maxLabels: 30, maxLabelChars: 60, maxNameChars: 60, maxUnitChars: 12 });
const STATS_LIMITS = Object.freeze({ maxTiles: 4, maxValueChars: 24, maxLabelChars: 60, maxDeltaChars: 24 });
const STEPS_LIMITS = Object.freeze({ maxSteps: 6, maxTitleChars: 60, maxTextChars: 160 });
const SLIDE_STYLES = Object.freeze(['accent', 'dark']);

// ── Numbers ─────────────────────────────────────────────────────────────

const NUMBER_SUFFIX = Object.freeze({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, mln: 1e6, mrd: 1e9, b: 1e9, B: 1e9 });

/**
 * A number out of human text. Handles currency signs, thousands separators in
 * either convention, a trailing %, and k/M/B suffixes. Returns null when the
 * text is not a number at all.
 */
function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    if (!s) return null;
    s = s.replace(/[€$£¥]/g, '').replace(/\s+/g, '').replace(/%$/, '');
    let mult = 1;
    const suffix = /([a-zA-Z]+)$/.exec(s);
    if (suffix && NUMBER_SUFFIX[suffix[1]] !== undefined) { mult = NUMBER_SUFFIX[suffix[1]]; s = s.slice(0, -suffix[1].length); }
    if (!/^[-+]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
        // Both present: the later one is the decimal mark.
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma !== -1) {
        // Only commas: "1,234,567" (groups of three) is thousands; "1,5" is decimal.
        const parts = s.replace(/^[-+]/, '').split(',');
        s = parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3 ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (lastDot !== -1) {
        const parts = s.replace(/^[-+]/, '').split('.');
        s = parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3 ? s.replace(/\./g, '') : s;
        if ((s.match(/\./g) || []).length > 1) return null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n * mult : null;
}

/** True when the cell reads as a number (a blank cell is neither). */
function isNumeric(value) {
    if (value === null || value === undefined || value === '') return false;
    return parseNumber(value) !== null;
}

function clip(text, max) {
    const s = String(text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function chartType(value, fallback = 'column') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (CHART_TYPES.includes(v)) return v;
    return CHART_TYPE_ALIASES[v] || fallback;
}

function toBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !['false', '0', 'no', 'nee', 'off'].includes(String(value).trim().toLowerCase());
}

// ── Source shapes → { labels, series } ─────────────────────────────────

function splitList(text) {
    return String(text).split(/[,;|\t]/).map((s) => s.trim()).filter((s) => s !== '');
}

function namedColumns(text) {
    if (Array.isArray(text)) return text.map((t) => String(t).trim()).filter(Boolean);
    return typeof text === 'string' && text.trim() ? splitList(text) : [];
}

/** Rows of objects → labels + series, by named columns or by auto-detection. */
function fromRows(rows, { labels: labelCol = null, values: valueCols = [] } = {}, warnings) {
    const list = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (!list.length) return null;
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
    const share = (col, test) => list.filter((r) => test(r[col])).length / list.length;
    const numericCols = cols.filter((c) => share(c, isNumeric) >= 0.5);
    const textCols = cols.filter((c) => !numericCols.includes(c) && share(c, (v) => v !== null && v !== undefined && String(v).trim() !== '') >= 0.5);

    let labelKey = labelCol && cols.includes(labelCol) ? labelCol : null;
    if (labelCol && !labelKey) warnings.push(`chart: there is no column "${labelCol}" for the labels — the first text column is used`);
    if (!labelKey) labelKey = textCols[0] || null;

    let seriesKeys = valueCols.filter((c) => cols.includes(c));
    for (const c of valueCols) if (!cols.includes(c)) warnings.push(`chart: there is no column "${c}" — it was skipped`);
    if (!seriesKeys.length) seriesKeys = numericCols.filter((c) => c !== labelKey);
    if (!seriesKeys.length) return null;

    const labels = list.map((r, i) => (labelKey ? clip(r[labelKey] ?? '', CHART_LIMITS.maxLabelChars) : String(i + 1)));
    const series = seriesKeys.map((k) => ({ name: clip(k, CHART_LIMITS.maxNameChars), values: list.map((r) => parseNumber(r[k])) }));
    return { labels, series };
}

/** A matrix (first row = header) → labels from the first column, series per numeric column. */
function fromMatrix(matrix, opts, warnings) {
    const rows = matrix.filter(Array.isArray);
    if (rows.length < 2) return null;
    const header = rows[0].map((h) => String(h ?? '').trim());
    const objects = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h || `col${i + 1}`, r[i]])));
    return fromRows(objects, {
        labels: opts.labels || header[0],
        values: opts.values && opts.values.length ? opts.values : [],
    }, warnings);
}

/** `{ columns, rows }` (the deck's own table shape, rows as arrays or objects). */
function fromTable(table, opts, warnings) {
    const columns = Array.isArray(table.columns) ? table.columns.map((c) => (typeof c === 'object' && c ? String(c.label ?? c.name ?? c.key ?? '') : String(c ?? ''))) : [];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    if (rows.length && rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return fromRows(rows, opts, warnings);
    return fromMatrix([columns, ...rows.filter(Array.isArray)], opts, warnings);
}

/** `{ labels, series:[{name, values}] }` or `{ labels, values }` (one series). */
function fromSpec(spec, _warnings) {
    const labels = Array.isArray(spec.labels) ? spec.labels.map((l) => clip(l, CHART_LIMITS.maxLabelChars)) : null;
    let series = [];
    if (Array.isArray(spec.series)) {
        series = spec.series.map((s, i) => {
            if (Array.isArray(s)) return { name: `Series ${i + 1}`, values: s.map(parseNumber) };
            if (s && typeof s === 'object') {
                const vals = Array.isArray(s.values) ? s.values : (Array.isArray(s.data) ? s.data : []);
                return { name: clip(s.name ?? s.label ?? s.key ?? `Series ${i + 1}`, CHART_LIMITS.maxNameChars), values: vals.map(parseNumber) };
            }
            return null;
        }).filter(Boolean);
    } else if (Array.isArray(spec.values)) {
        series = [{ name: clip(spec.name ?? spec.title ?? '', CHART_LIMITS.maxNameChars), values: spec.values.map(parseNumber) }];
    } else if (spec.values && typeof spec.values === 'object') {
        // { values: { Q1: 10, Q2: 20 } }
        const entries = Object.entries(spec.values);
        return { labels: entries.map(([k]) => clip(k, CHART_LIMITS.maxLabelChars)), series: [{ name: '', values: entries.map(([, v]) => parseNumber(v)) }] };
    }
    if (!series.length) return null;
    const n = labels ? labels.length : Math.max(...series.map((s) => s.values.length));
    if (!n) return null;
    return { labels: labels || Array.from({ length: n }, (_, i) => String(i + 1)), series };
}

const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
}

/**
 * The text forms: JSON, a markdown table, or the ```chart line grammar —
 * `key: value` settings, `labels: a, b, c`, and `Name: 1, 2, 3` series (or
 * `Label: value` per line when no labels line is given).
 */
function fromText(text, opts, warnings) {
    const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!raw) return null;
    if (/^[[{]/.test(raw)) {
        try { return fromAny(JSON.parse(raw), opts, warnings); } catch { /* not JSON: fall through to the line grammar */ }
    }
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2 && RE_TABLE_ROW.test(lines[0]) && RE_TABLE_SEP.test(lines[1])) {
        const matrix = [splitTableRow(lines[0]), ...lines.slice(2).filter((l) => RE_TABLE_ROW.test(l)).map(splitTableRow)];
        return fromMatrix(matrix, opts, warnings);
    }
    const settings = {};
    let labels = null;
    const pairs = [];
    for (const line of lines) {
        const m = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].trim();
        const val = m[2].trim();
        const lower = key.toLowerCase();
        if (lower === 'labels') { labels = splitList(val); continue; }
        if (['type', 'title', 'unit', 'stacked', 'showvalues'].includes(lower)) { settings[lower] = val; continue; }
        pairs.push([key, val]);
    }
    if (!pairs.length) return null;
    /** @type {{ labels: string[], series: Array<{ name: string, values: number[] }>, settings?: any }} */
    let data;
    if (labels) {
        // Series lines: "Name: 1, 2, 3"
        data = { labels: labels.map((l) => clip(l, CHART_LIMITS.maxLabelChars)), series: pairs.map(([k, v]) => ({ name: clip(k, CHART_LIMITS.maxNameChars), values: splitList(v).map(parseNumber) })) };
    } else if (pairs.every(([, v]) => splitList(v).length > 1)) {
        // Several values per line and no labels: the lines are series, labels are 1..n
        const n = Math.max(...pairs.map(([, v]) => splitList(v).length));
        data = { labels: Array.from({ length: n }, (_, i) => String(i + 1)), series: pairs.map(([k, v]) => ({ name: clip(k, CHART_LIMITS.maxNameChars), values: splitList(v).map(parseNumber) })) };
    } else {
        // "Label: value" lines — one series
        data = { labels: pairs.map(([k]) => clip(k, CHART_LIMITS.maxLabelChars)), series: [{ name: '', values: pairs.map(([, v]) => parseNumber(v)) }] };
    }
    data.settings = settings;
    return data;
}

function fromAny(value, opts, warnings) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return fromText(value, opts, warnings);
    if (Array.isArray(value)) {
        if (!value.length) return null;
        if (value.every((r) => Array.isArray(r))) return fromMatrix(value, opts, warnings);
        if (value.every((r) => typeof r === 'number' || (typeof r === 'string' && isNumeric(r)))) {
            return { labels: value.map((_, i) => String(i + 1)), series: [{ name: '', values: value.map(parseNumber) }] };
        }
        // A list wrapped by a step ({ rows }, { results }) or plain rows
        return fromRows(value.map((r) => (r && typeof r === 'object' && r.output && typeof r.output === 'object' && !Array.isArray(r.output) ? r.output : r)), opts, warnings);
    }
    if (typeof value === 'object') {
        if (Array.isArray(value.series) || Array.isArray(value.values) || (value.values && typeof value.values === 'object' && !Array.isArray(value.values))) return fromSpec(value, warnings);
        if (Array.isArray(value.rows) || Array.isArray(value.columns)) return Array.isArray(value.columns) ? fromTable(value, opts, warnings) : fromAny(value.rows, opts, warnings);
        for (const k of ['data', 'results', 'items', 'records', 'output']) if (value[k] !== undefined) return fromAny(value[k], opts, warnings);
        // A flat { Q1: 10, Q2: 20 } object
        const entries = Object.entries(value).filter(([, v]) => isNumeric(v));
        if (entries.length) return { labels: entries.map(([k]) => clip(k, CHART_LIMITS.maxLabelChars)), series: [{ name: '', values: entries.map(([, v]) => parseNumber(v)) }] };
    }
    return null;
}

// ── Public collectors ───────────────────────────────────────────────────

/**
 * Anything chart-like → the chart model, or null (with a warning) when no
 * numbers could be found.
 *
 * @param {*} input        rows | matrix | {labels,series} | {columns,rows} | markdown table | ```chart text | {type, data, labels?, values?, …}
 * @param {object} [opts]  { type, labels, values, stacked, unit, title, showValues } — defaults the input may override
 * @param {string[]} [warnings]
 */
function chartFromAny(input, opts = {}, warnings = []) {
    let source = input;
    let o = { ...opts };
    // A wrapper that names its own data: { type, data, labels, values, … }
    if (source && typeof source === 'object' && !Array.isArray(source) && source.data !== undefined && !Array.isArray(source.series)) {
        o = { ...o, ...source, data: undefined };
        source = source.data;
    } else if (source && typeof source === 'object' && !Array.isArray(source) && (source.type || source.stacked !== undefined || source.unit) && (Array.isArray(source.series) || Array.isArray(source.labels) || source.table || source.rows)) {
        o = { ...o, ...source };
        source = source.table || source.rows || source;
    }
    const colOpts = { labels: typeof o.labels === 'string' ? o.labels.trim() : null, values: namedColumns(o.values) };
    const data = fromAny(source, colOpts, warnings);
    if (!data || !data.series.length) { warnings.push('chart: no numbers were found in the data — the chart was left out'); return null; }
    const settings = data.settings || {};

    let series = data.series.slice(0, CHART_LIMITS.maxSeries);
    if (data.series.length > CHART_LIMITS.maxSeries) warnings.push(`chart: only the first ${CHART_LIMITS.maxSeries} series are shown`);
    let labels = data.labels.slice(0, CHART_LIMITS.maxLabels);
    if (data.labels.length > CHART_LIMITS.maxLabels) warnings.push(`chart: only the first ${CHART_LIMITS.maxLabels} points are shown`);
    series = series.map((s) => ({
        name: s.name || '',
        values: Array.from({ length: labels.length }, (_, i) => (typeof s.values[i] === 'number' && Number.isFinite(s.values[i]) ? s.values[i] : null)),
    })).filter((s) => s.values.some((v) => v !== null));
    if (!series.length) { warnings.push('chart: no numbers were found in the data — the chart was left out'); return null; }

    let type = chartType(o.type ?? settings.type, chartType(settings.type, 'column'));
    if ((type === 'pie' || type === 'donut') && series.length > 1) {
        warnings.push(`chart: a ${type} chart shows one series — the first one is used`);
        series = series.slice(0, 1);
    }
    return {
        type,
        labels,
        series,
        stacked: toBool(o.stacked ?? settings.stacked, false) && (type === 'column' || type === 'bar' || type === 'area'),
        showValues: toBool(o.showValues ?? settings.showvalues, true),
        unit: clip(o.unit ?? settings.unit ?? '', CHART_LIMITS.maxUnitChars),
        title: clip(o.title ?? settings.title ?? '', CHART_LIMITS.maxLabelChars),
    };
}

/**
 * KPI tiles. Accepts a list of `{value,label,delta}` objects, strings
 * "value | label | delta", a multi-line string of those, or a flat object
 * `{ Omzet: '€ 1,2M' }`. At most STATS_LIMITS.maxTiles.
 */
function statsFromAny(input, warnings = []) {
    let items = [];
    if (typeof input === 'string') {
        items = input.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
        if (items.length === 1 && /^[[{]/.test(items[0])) {
            try { return statsFromAny(JSON.parse(items[0]), warnings); } catch { /* keep the line */ }
        }
    } else if (Array.isArray(input)) {
        items = input;
    } else if (input && typeof input === 'object') {
        if (Array.isArray(input.items) || Array.isArray(input.stats)) return statsFromAny(input.items || input.stats, warnings);
        items = Object.entries(input).map(([label, value]) => ({ label, value }));
    }
    const tiles = [];
    for (const it of items) {
        let tile = null;
        if (typeof it === 'string' || typeof it === 'number') {
            const parts = String(it).replace(/^[-*+]\s+/, '').split('|').map((p) => p.trim());
            if (parts[0]) tile = { value: parts[0], label: parts[1] || '', delta: parts[2] || null, icon: (parts[3] || '').replace(/^icon\s*:\s*/i, '') || null };
        } else if (it && typeof it === 'object') {
            const value = it.value ?? it.number ?? it.amount ?? it.count ?? '';
            if (value !== '' && value !== null && value !== undefined) {
                tile = { value: String(value), label: String(it.label ?? it.title ?? it.name ?? ''), delta: it.delta !== undefined && it.delta !== null && it.delta !== '' ? String(it.delta) : (it.trend ? String(it.trend) : null), icon: it.icon ? String(it.icon) : null };
            }
        }
        if (tile) tiles.push({ value: clip(tile.value, STATS_LIMITS.maxValueChars), label: clip(tile.label, STATS_LIMITS.maxLabelChars), delta: tile.delta ? clip(tile.delta, STATS_LIMITS.maxDeltaChars) : null, icon: tile.icon ? clip(tile.icon, 40) : null });
    }
    if (tiles.length > STATS_LIMITS.maxTiles) warnings.push(`only the first ${STATS_LIMITS.maxTiles} KPI tiles fit on a slide`);
    return tiles.slice(0, STATS_LIMITS.maxTiles);
}

/**
 * Timeline / process steps out of bullets (or a list of strings/objects):
 * "Title — text", "Title: text" or "Title | text"; the level-1 bullets under
 * a step become its text.
 */
function stepsFromAny(input, warnings = []) {
    const out = [];
    const push = (title, text) => {
        const t = clip(title, STEPS_LIMITS.maxTitleChars);
        if (t) out.push({ title: t, text: text ? clip(text, STEPS_LIMITS.maxTextChars) : null });
    };
    const list = typeof input === 'string' ? input.replace(/\r\n?/g, '\n').split('\n').map((l) => ({ text: l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''), level: /^\s{2,}/.test(l) ? 1 : 0 })).filter((b) => b.text.trim()) : (Array.isArray(input) ? input : []);
    for (const b of list) {
        if (b && typeof b === 'object' && !('text' in b && 'level' in b)) {
            push(b.title ?? b.label ?? b.name ?? '', b.text ?? b.description ?? b.body ?? '');
            continue;
        }
        const item = b && typeof b === 'object' ? b : { text: String(b ?? ''), level: 0 };
        if (item.level && out.length) {
            const last = out[out.length - 1];
            last.text = clip([last.text, item.text].filter(Boolean).join(' '), STEPS_LIMITS.maxTextChars);
            continue;
        }
        const m = /^(.+?)\s*(?:—|–|--|:|\|)\s+(.+)$/.exec(String(item.text ?? '').trim());
        if (m) push(m[1], m[2]); else push(item.text, '');
    }
    if (out.length > STEPS_LIMITS.maxSteps) warnings.push(`only the first ${STEPS_LIMITS.maxSteps} steps fit on a timeline slide`);
    return out.slice(0, STEPS_LIMITS.maxSteps);
}

function slideStyle(value) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SLIDE_STYLES.includes(v) ? v : null;
}

module.exports = {
    CHART_TYPES,
    CHART_LIMITS,
    STATS_LIMITS,
    STEPS_LIMITS,
    SLIDE_STYLES,
    parseNumber,
    isNumeric,
    chartType,
    chartFromAny,
    statsFromAny,
    stepsFromAny,
    slideStyle,
};
