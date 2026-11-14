// @typecheck strict
/**
 * One normalised slide out of parsed fields plus the explicit bits a JSON
 * slide carries: the base slide, then its chart, its KPI tiles and steps, its
 * ### blocks (two columns, cards, or folded back into the bullets) and last
 * the layout. The steps run in this order; each may add warnings.
 */

'use strict';

const { chartFromAny, statsFromAny, stepsFromAny, slideStyle } = require('./deckChart');
const { normaliseIconName } = require('./deckIcons');
const { SLIDE_LAYOUTS, MAX_CARDS, stripInlineMarkdown, inferLayout } = require('./deckBase');

/**
 * @typedef {import('./deckParseLines').SlideFields} SlideFields
 * @typedef {import('./deckParseLines').Column} Column
 * @typedef {import('./deckParseLines').Bullet} Bullet
 * @typedef {import('./deckParseLines').ImageRef} ImageRef
 * @typedef {NonNullable<ReturnType<typeof chartFromAny>>} Chart
 * @typedef {ReturnType<typeof statsFromAny>} Stats
 * @typedef {ReturnType<typeof stepsFromAny>} Steps
 * @typedef {{ title: string | null, text: string | null, icon: string | null, image: ImageRef | null }} Card
 * @typedef {{ layout: string | null, title: string, bullets: Bullet[], columns: { title: string | null, bullets: Bullet[] }[] | null, body: string | null,
 *   table: SlideFields['table'], image: ImageRef | null, quote: { text: string, attribution: string | null } | null, chart: Chart | null,
 *   stats: Stats | null, steps: Steps | null, cards: Card[] | null, style: string | null, notes: string | null }} Slide
 * @typedef {{ layout?: string | null, notes?: string | null, image?: ImageRef | null, chart?: Chart | null, stats?: Stats | null,
 *   steps?: Steps | null, style?: unknown, warnings?: string[] }} SlideExtras
 */

/** @param {string[]} parts */
function joinBody(parts) {
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One card out of a parsed ### block (or a JSON card): title, text, an icon name, a picture.
 * @param {Column} c
 * @param {string[]} warnings
 * @returns {Card}
 */
function cardFrom(c, warnings) {
    let icon = null;
    if (c.icon) {
        icon = normaliseIconName(c.icon);
        if (!icon) warnings.push(`unknown icon "${String(c.icon).slice(0, 40)}" was skipped`);
    }
    return {
        title: c.title || null,
        text: [joinBody(c.body || []), ...(c.bullets || []).map((b) => b.text)].filter(Boolean).join('\n') || null,
        icon,
        image: c.image && !c.image.rejected ? c.image : null,
    };
}

/**
 * The slide before its visuals and columns: texts, table, image, quote, style, notes.
 * @param {string} title
 * @param {SlideFields} f
 * @param {SlideExtras} extras
 * @returns {Slide}
 */
function baseSlide(title, f, { notes = null, image = null, style = null }) {
    return {
        layout: null,
        title: stripInlineMarkdown(title),
        bullets: f.bullets.slice(),
        columns: null,
        body: joinBody(f.body) || null,
        table: f.table,
        image: image || f.image || null,
        quote: f.quote && (f.quote.lines.length || f.quote.attribution)
            ? { text: f.quote.lines.join(' '), attribution: f.quote.attribution || null }
            : null,
        chart: null,
        stats: null,
        steps: null,
        cards: null,
        style: slideStyle(style || f.styleHint),
        notes: [notes, ...f.notes].filter((n) => n && String(n).trim()).map((n) => String(n).trim()).join('\n') || null,
    };
}

/**
 * The chart: an explicit one, else the chart block, else "<!-- chart -->"
 * turning the table into one (the table is then the chart's data, not a
 * second thing on the slide).
 * @param {Slide} slide
 * @param {SlideFields} f
 * @param {Chart | null} chart
 * @param {string[]} warnings
 */
function applyChart(slide, f, chart, warnings) {
    if (chart) slide.chart = chart;
    else if (f.chartText !== null) slide.chart = chartFromAny(f.chartText, { type: f.chartHint || undefined }, warnings);
    else if (f.chartHint && f.table) {
        slide.chart = chartFromAny({ columns: f.table.columns, rows: f.table.rows }, { type: f.chartHint }, warnings);
        if (slide.chart) slide.table = null;
    } else if (f.chartHint) warnings.push('"<!-- chart -->" needs a table or a ```chart block on the slide');
}

/**
 * Each tile's icon resolved to a known name; an unknown one is a warning and no icon.
 * @param {Stats} stats
 * @param {string[]} warnings
 */
function resolveStatIcons(stats, warnings) {
    for (const t of stats) {
        if (!t.icon) continue;
        const n = normaliseIconName(t.icon);
        if (!n) warnings.push(`unknown icon "${t.icon}" was skipped`);
        t.icon = n;
    }
    return stats;
}

/**
 * KPI tiles (explicit ones, else the stats block) and explicit steps.
 * @param {Slide} slide
 * @param {SlideFields} f
 * @param {SlideExtras} extras
 * @param {string[]} warnings
 */
function applyStatsAndSteps(slide, f, { stats = null, steps = null }, warnings) {
    if (stats) slide.stats = stats;
    else if (f.statsText !== null) slide.stats = resolveStatIcons(statsFromAny(f.statsText, warnings), warnings);
    if (slide.stats && !slide.stats.length) slide.stats = null;
    if (steps && steps.length) slide.steps = steps;
}

/**
 * What the ### blocks with content become.
 * @param {number} count
 * @param {boolean} asCards  the layout asks for cards
 * @returns {'columns' | 'cards' | 'fold'}
 */
function columnsKind(count, asCards) {
    if (count === 2) return asCards ? 'cards' : 'columns';
    return count >= 3 && count <= MAX_CARDS ? 'cards' : 'fold';
}

/**
 * A column heading and its content back into the slide's own bullets and text.
 * @param {Slide} slide
 * @param {Column} c
 */
function foldColumn(slide, c) {
    if (c.title) slide.bullets.push({ text: c.title, level: 0 });
    for (const b of c.bullets) slide.bullets.push({ text: b.text, level: 1 });
    const body = joinBody(c.body);
    if (body) slide.body = slide.body ? `${slide.body}\n\n${body}` : body;
}

/**
 * Two columns with content = a two-column slide; three to MAX_CARDS (or two
 * under a cards layout) = cards; anything else folds back.
 * @param {Slide} slide
 * @param {SlideFields} f
 * @param {string | null} layout
 * @param {string[]} warnings
 */
function applyColumns(slide, f, layout, warnings) {
    const cols = f.columns.filter((c) => c.bullets.length || c.body.length || c.title);
    const kind = columnsKind(cols.length, layout === 'cards' || f.layoutHint === 'cards');
    if (kind === 'columns') {
        slide.columns = cols.map((c) => ({
            title: c.title || null,
            bullets: c.bullets.length ? c.bullets : joinBody(c.body).split(/\n+/).filter(Boolean).map((t) => ({ text: t, level: 0 })),
        }));
    } else if (kind === 'cards') {
        slide.cards = cols.map((c) => cardFrom(c, warnings));
    } else {
        for (const c of cols) foldColumn(slide, c);
    }
}

const STEP_HINTS = new Set(['timeline', 'steps', 'process']);

/**
 * The layout: the hint when it names one (steps and process are a timeline,
 * whose bullets are read as steps and stay for the fallback text), else the
 * one the content implies.
 * @param {Slide} slide
 * @param {string | null} hint
 * @param {string[]} warnings
 */
function applyLayout(slide, hint, warnings) {
    const stepHint = hint !== null && STEP_HINTS.has(hint);
    if (stepHint && !slide.steps && slide.bullets.length) slide.steps = stepsFromAny(slide.bullets, warnings);
    const named = stepHint ? 'timeline' : hint;
    slide.layout = named !== null && SLIDE_LAYOUTS.includes(named) ? named : inferLayout(slide);
}

/**
 * Assemble one normalised slide from parsed fields plus the explicit bits.
 * @param {string} title
 * @param {SlideFields} f
 * @param {SlideExtras} [extras]
 */
function slideFromFields(title, f, extras = {}) {
    const warnings = /** @type {string[]} */ (extras.warnings);
    const layout = extras.layout || null;
    const slide = baseSlide(title, f, extras);
    for (const w of f.warnings) warnings.push(w);
    applyChart(slide, f, extras.chart || null, warnings);
    applyStatsAndSteps(slide, f, extras, warnings);
    applyColumns(slide, f, layout, warnings);
    applyLayout(slide, layout || f.layoutHint, warnings);
    return slide;
}

module.exports = { slideFromFields, joinBody, resolveStatIcons };
