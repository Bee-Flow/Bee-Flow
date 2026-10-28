// @typecheck
const { chartFromAny, statsFromAny, stepsFromAny, slideStyle, chartType } = require('./deckChart');
const { normaliseIconName } = require('./deckIcons');
const { SLIDE_LAYOUTS, MAX_CARDS, RE_ICON_TAG, DECK_LIMITS, DeckError, stripInlineMarkdown, clampText, classifyImageRef, inferLayout } = require('./deckBase');

const RE_BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

const RE_H1 = /^#\s+(.*)$/;

const RE_H2 = /^##\s+(.*)$/;

const RE_H3 = /^###\s+(.*)$/;

const RE_QUOTE = /^>\s?(.*)$/;

const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;

const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const RE_IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const RE_NOTES_PARA = /^(?:speaker\s+notes|notes|notities|sprekersnotities)\s*:\s*(.*)$/i;

const RE_COMMENT_ONE = /^\s*<!--\s*(layout|notes|chart|style)\s*:\s*([\s\S]*?)\s*-->\s*$/i;

const RE_COMMENT_OPEN = /^\s*<!--\s*(notes)\s*:\s*([\s\S]*)$/i;

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_-]*)\s*$/;

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
}

/**
 * @typedef {{ text: string, level?: number }} Bullet
 * @typedef {{ title: string, bullets: Bullet[], body: string[], icon?: string | null, image?: unknown }} Column
 * @typedef {{ lines: string[], attribution: string | null }} Quote
 * @typedef {{ columns: string[], rows: string[][] }} Table
 * @typedef {{ bullets: Bullet[], body: string[], table: Table | null, quote: Quote | null, image: unknown, notes: string[], layoutHint: string | null,
 *   columns: Column[], warnings: string[], chartText: string | null, chartHint: string | null, statsText: string | null, styleHint: string | null }} SlideFields
 */

/** @returns {SlideFields} */
function emptyFields() {
    return {
        bullets: [], body: [], table: null, quote: null, image: null, notes: [], layoutHint: null, columns: [], warnings: [],
        chartText: null, chartHint: null, statsText: null, styleHint: null,
    };
}

/**
 * Parse the lines of one slide's content. `###` headings open a column; when
 * exactly two columns end up with content the slide is two-column, otherwise
 * the column headings are folded back in as bullets.
 */
function parseSlideLines(lines) {
    const f = emptyFields();
    /** @type {SlideFields | Column} */
    let target = f;                 // where bullets/body go: the slide or the current column
    let noteMode = false;           // a trailing "Notes:" paragraph swallows the rest
    let commentNotes = null;        // inside a multi-line <!-- notes: … -->
    let fence = null;               // inside a ``` block: { marker, lang, lines }
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        i += 1;

        // Fenced blocks first: ```chart and ```stats are visuals, any other
        // language is prose the slide prints as-is (a code sample on a slide).
        if (fence) {
            const close = RE_FENCE.exec(line);
            if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length && !close[2]) {
                const text = fence.lines.join('\n');
                if (fence.lang === 'chart') { if (f.chartText === null) f.chartText = text; else f.warnings.push('a slide can hold one chart; the extra chart was skipped'); }
                else if (fence.lang === 'stats' || fence.lang === 'kpi') { if (f.statsText === null) f.statsText = text; else f.warnings.push('a slide can hold one row of KPI tiles; the extra one was skipped'); }
                else target.body.push(...fence.lines.map((l) => l.trim()));
                fence = null;
            } else {
                fence.lines.push(line);
            }
            continue;
        }
        let fm;
        if (commentNotes === null && !noteMode && (fm = RE_FENCE.exec(line))) {
            fence = { marker: fm[1], lang: fm[2].toLowerCase(), lines: [] };
            continue;
        }

        if (commentNotes !== null) {
            const end = line.indexOf('-->');
            if (end === -1) { commentNotes.push(line); continue; }
            commentNotes.push(line.slice(0, end));
            f.notes.push(commentNotes.join('\n').trim());
            commentNotes = null;
            continue;
        }
        if (noteMode) { f.notes.push(line); continue; }

        let m;
        if ((m = RE_COMMENT_ONE.exec(line))) {
            const kind = m[1].toLowerCase();
            const val = m[2].trim();
            if (kind === 'layout') f.layoutHint = val.toLowerCase().replace(/-/g, '_');
            else if (kind === 'chart') f.chartHint = chartType(val, 'column');
            else if (kind === 'style') f.styleHint = val.toLowerCase();
            else f.notes.push(val);
            continue;
        }
        if ((m = RE_COMMENT_OPEN.exec(line))) { commentNotes = [m[2]]; continue; }
        if (!line.trim()) { if (target.body.length && target.body[target.body.length - 1] !== '') target.body.push(''); continue; }

        if ((m = RE_NOTES_PARA.exec(line.trim()))) { noteMode = true; if (m[1]) f.notes.push(m[1]); continue; }
        if ((m = RE_H3.exec(line))) {
            const iconTag = RE_ICON_TAG.exec(m[1]);
            /** @type {Column} */
            const col = { title: stripInlineMarkdown(iconTag ? m[1].replace(RE_ICON_TAG, '') : m[1]), bullets: [], body: [], icon: iconTag ? iconTag[1].trim() : null, image: null };
            f.columns.push(col);
            target = col;
            continue;
        }
        if ((m = RE_IMAGE.exec(line))) {
            const ref = classifyImageRef(m[2], m[1]);
            if (ref && ref.rejected) f.warnings.push(`remote image "${ref.rejected.slice(0, 80)}" was skipped — only Bee Flow storage or data: images can be placed on a slide`);
            else if (ref && target !== f && !target.image) target.image = ref; // a picture inside a ### block belongs to that card
            else if (ref && !f.image) f.image = ref;
            else if (ref) f.warnings.push('a slide can hold one image; the extra image was skipped');
            continue;
        }
        if ((m = RE_BULLET.exec(line))) {
            const indent = m[1].replace(/\t/g, '  ').length;
            target.bullets.push({ text: stripInlineMarkdown(m[2]), level: indent >= 2 ? 1 : 0 });
            continue;
        }
        if ((m = RE_QUOTE.exec(line))) {
            const q = f.quote || { lines: [], attribution: null };
            const text = m[1].trim();
            const attr = /^(?:—|--|–)\s*(.+)$/.exec(text);
            if (attr) q.attribution = stripInlineMarkdown(attr[1]);
            else if (text) q.lines.push(stripInlineMarkdown(text));
            f.quote = q;
            continue;
        }
        if (RE_TABLE_ROW.test(line) && i < lines.length && RE_TABLE_SEP.test(lines[i])) {
            const header = splitTableRow(line).map(stripInlineMarkdown);
            i += 1; // the separator
            const rows = [];
            while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
                rows.push(splitTableRow(lines[i]).map(stripInlineMarkdown));
                i += 1;
            }
            if (!f.table) f.table = { columns: header, rows };
            else f.warnings.push('a slide can hold one table; the extra table was skipped');
            continue;
        }
        target.body.push(line.trim());
    }
    if (fence) {
        // An unclosed fence at the end of a slide: keep what it held.
        const text = fence.lines.join('\n');
        if (fence.lang === 'chart' && f.chartText === null) f.chartText = text;
        else if ((fence.lang === 'stats' || fence.lang === 'kpi') && f.statsText === null) f.statsText = text;
        else target.body.push(...fence.lines.map((l) => l.trim()));
    }
    return f;
}

/** Turn a heading-free, line-based markdown fragment into slide fields (used for JSON `content` too). */
function fieldsFromContent(content) {
    const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
    return parseSlideLines(lines);
}

function joinBody(parts) {
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One card out of a parsed ### block (or a JSON card): title, text, an icon name, a picture. */
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
 * Assemble one normalised slide from parsed fields plus the explicit bits.
 * @param {string} title
 * @param {ReturnType<typeof fieldsFromContent>} f
 * @param {{ layout?: string | null, notes?: string | null, image?: unknown, chart?: unknown, stats?: unknown, steps?: unknown[] | null, style?: unknown, warnings?: string[] }} [extras]
 */
function slideFromFields(title, f, { layout = null, notes = null, image = null, chart = null, stats = null, steps = null, style = null, warnings } = {}) {
    const slide = {
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
    for (const w of f.warnings) warnings.push(w);

    // Visuals: an explicit chart, else the ```chart block, else "<!-- chart -->"
    // turning the table into one (the table is then the chart's data, not a
    // second thing on the slide).
    if (chart) slide.chart = chart;
    else if (f.chartText !== null) slide.chart = chartFromAny(f.chartText, { type: f.chartHint || undefined }, warnings);
    else if (f.chartHint && f.table) { slide.chart = chartFromAny({ columns: f.table.columns, rows: f.table.rows }, { type: f.chartHint }, warnings); if (slide.chart) slide.table = null; }
    else if (f.chartHint) warnings.push('"<!-- chart -->" needs a table or a ```chart block on the slide');
    if (stats) slide.stats = stats;
    else if (f.statsText !== null) {
        slide.stats = statsFromAny(f.statsText, warnings);
        for (const t of slide.stats) { if (t.icon) { const n = normaliseIconName(t.icon); if (!n) warnings.push(`unknown icon "${t.icon}" was skipped`); t.icon = n; } }
    }
    if (slide.stats && !slide.stats.length) slide.stats = null;
    if (steps && steps.length) slide.steps = steps;

    // Two columns with content = a two-column slide; three or four = cards
    // (a title and a short text each); anything else folds back.
    const cols = f.columns.filter((c) => c.bullets.length || c.body.length || c.title);
    if (cols.length === 2 && layout !== 'cards' && f.layoutHint !== 'cards') {
        slide.columns = cols.map((c) => ({
            title: c.title || null,
            bullets: c.bullets.length ? c.bullets : joinBody(c.body).split(/\n+/).filter(Boolean).map((t) => ({ text: t, level: 0 })),
        }));
    } else if ((cols.length >= 3 && cols.length <= MAX_CARDS) || (cols.length === 2 && (layout === 'cards' || f.layoutHint === 'cards'))) {
        slide.cards = cols.map((c) => cardFrom(c, warnings));
    } else {
        for (const c of cols) {
            if (c.title) slide.bullets.push({ text: c.title, level: 0 });
            for (const b of c.bullets) slide.bullets.push({ text: b.text, level: 1 });
            const body = joinBody(c.body);
            if (body) slide.body = slide.body ? `${slide.body}\n\n${body}` : body;
        }
    }

    const hint = layout || f.layoutHint;
    // A timeline is bullets read as steps; the bullets stay for the fallback text.
    if ((hint === 'timeline' || hint === 'steps' || hint === 'process') && !slide.steps && slide.bullets.length) {
        slide.steps = stepsFromAny(slide.bullets, warnings);
    }
    slide.layout = SLIDE_LAYOUTS.includes(hint === 'steps' || hint === 'process' ? 'timeline' : hint) ? (hint === 'steps' || hint === 'process' ? 'timeline' : hint) : inferLayout(slide);
    return slide;
}

function deckFromMarkdown(markdown, warnings) {
    const md = String(markdown ?? '').replace(/\r\n?/g, '\n');
    if (md.length > DECK_LIMITS.maxMarkdownChars) {
        throw new DeckError(`The outline is ${md.length} characters; the limit is ${DECK_LIMITS.maxMarkdownChars}.`, 'deck_too_large');
    }
    const lines = md.split('\n');
    const deck = { title: '', subtitle: null, author: null, date: null, slides: [] };

    // Slice into [cover lines, {title, lines}...] on h2 (and on --- / a second h1).
    let cover = [];
    const sections = [];
    let cur = null;
    let pendingBreak = false;
    for (const line of lines) {
        let m;
        if ((m = RE_H1.exec(line)) && !deck.title && !cur) { deck.title = stripInlineMarkdown(m[1]); continue; }
        if ((m = RE_H2.exec(line)) || ((m = RE_H1.exec(line)) && (deck.title || cur))) {
            cur = { title: m[1], lines: [] };
            sections.push(cur);
            pendingBreak = false;
            continue;
        }
        if (RE_HR.test(line)) { pendingBreak = true; continue; }
        if (pendingBreak && line.trim()) {
            cur = { title: '', lines: [] };
            sections.push(cur);
            pendingBreak = false;
        }
        (cur ? cur.lines : cover).push(line);
    }

    // Cover material: the first paragraph is the subtitle; the rest is an intro slide.
    const coverFields = parseSlideLines(cover);
    const coverBody = joinBody(coverFields.body);
    if (coverBody) {
        const paras = coverBody.split(/\n{2,}/);
        deck.subtitle = clampText(paras.shift(), DECK_LIMITS.maxSubtitleChars, warnings, 'the subtitle');
        coverFields.body = paras.join('\n\n').split('\n');
    }
    if (coverFields.notes.length) {
        // Notes before the first slide belong to the cover; officegen puts
        // them on the cover slide.
        deck.coverNotes = coverFields.notes.join('\n');
    }
    const introHas = coverFields.bullets.length || joinBody(coverFields.body) || coverFields.table || coverFields.quote || coverFields.image;
    if (introHas) {
        deck.slides.push(slideFromFields(deck.title, coverFields, { warnings }));
    }

    for (const s of sections) {
        const f = parseSlideLines(s.lines);
        deck.slides.push(slideFromFields(s.title, f, { warnings }));
    }
    return deck;
}

module.exports = { parseSlideLines, fieldsFromContent, slideFromFields, deckFromMarkdown };
