/**
 * Deck model — the one shape every presentation surface agrees on.
 *
 * A deck comes in as either a MARKDOWN outline (what an ai_step or a chat
 * model writes most naturally) or a JSON deck (what a tool call or an automation
 * binding produces), and leaves as one normalised structure that both the
 * .pptx builder (integrations/officegen.js) and the PDF deck renderer
 * (services/documentRenderer.js deckToSlidesHtml) consume. The renderers never
 * parse text; this module never renders. That split is what keeps the chat
 * tool, the Nextcloud tool, the automation step and the App Studio step producing
 * the same deck from the same input.
 *
 * MARKDOWN GRAMMAR — deliberately the contract buildSlidesHtml already had, so
 * every existing "layout: slides" document reads the same way:
 *
 *     # Title                     → the cover (deck.title)
 *     first paragraph before ##   → cover subtitle; anything else before the
 *                                   first ## becomes an intro slide
 *     ## Heading                  → one slide per heading
 *     ### Left / ### Right        → exactly two inside a slide = two columns
 *     ### A / ### B / ### C (…F)  → three to six inside a slide = cards (title + short text each);
 *                                   two become cards too under <!-- layout: cards -->
 *     ### Title {icon: wifi-off}  → the card's icon (Lucide names; deckIcons.js); an image
 *                                   line inside the block is the card's picture
 *     - bullet / * / 1.           → bullets; two-space indent = sub-bullet
 *     > quote / > — attribution   → a quote slide
 *     | a | b |                   → a table slide (GFM)
 *     ![alt](src)                 → an image slide (data: or Bee Flow storage only)
 *     <!-- layout: quote -->      → force a layout (timeline = the bullets become numbered steps)
 *     <!-- notes: … -->           → speaker notes (multi-line allowed)
 *     Notes: …  (last paragraph)  → speaker notes, the lazy spelling
 *     ---                         → a slide break without a heading
 *
 * VISUALS (core/documents/deckChart.js collects them):
 *
 *     ```chart                    → a chart: "type: bar" (column|bar|line|area|pie|donut),
 *     type: bar                     "labels: Q1, Q2, Q3" then one "Name: 1, 2, 3" line per
 *     labels: Q1, Q2, Q3            series — or "Label: value" lines for one series — or
 *     Omzet: 10, 20, 30             JSON rows / {labels, series}. "unit: %", "stacked: true".
 *     ```
 *     <!-- chart: bar -->         → the slide's table becomes that chart (first column = labels,
 *                                   numeric columns = series); the table itself is not shown
 *     ```stats                    → KPI tiles, one per line: value | label | delta (max 4)
 *     € 1,2M | Omzet | +12%
 *     ```
 *     <!-- style: accent -->      → this slide painted in the accent colour (or "dark")
 *
 * IMAGES ARE REFERENCES, NOT BYTES, and remote ones are dropped here. The
 * renderer decides how a reference becomes bytes (a storage key it may read on
 * behalf of the caller, a data: URL as-is). An http(s) URL is never fetched by
 * anything in this pipeline: the deck is untrusted input on its way into a
 * library that would happily fetch it, and a fetch from the server is an SSRF
 * primitive. Dropping it with a warning is the honest outcome.
 *
 * CAPS ARE PART OF THE MODEL. A slide with forty bullets is not a slide; the
 * overflow becomes a continuation slide rather than an unreadable one, and a
 * deck past MAX_SLIDES is refused rather than silently cut — the author must
 * see that something was too big, never discover it in front of an audience.
 *
 * Pure: no I/O, no dependencies, cheap to unit-test.
 */

const { chartFromAny, statsFromAny, stepsFromAny, slideStyle, chartType, CHART_TYPES, SLIDE_STYLES } = require('./deckChart');
const { normaliseIconName } = require('./deckIcons');

const SLIDE_LAYOUTS = Object.freeze(['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing']);
const MAX_CARDS = 6;
/** `{icon: wifi-off}` (or `[icon: …]`) anywhere in a heading names the card's icon. */
const RE_ICON_TAG = /\s*[[{]\s*icon\s*:\s*([a-z0-9 _-]+?)\s*[\]}]/i;

const DECK_LIMITS = Object.freeze({
    maxSlides: 60,
    maxBulletsPerSlide: 10,
    maxBulletChars: 240,
    maxTitleChars: 120,
    maxSubtitleChars: 200,
    maxBodyChars: 1200,
    maxNotesChars: 3000,
    maxQuoteChars: 400,
    maxTableRows: 15,
    maxTableCols: 8,
    maxCellChars: 120,
    maxImageBytes: 4 * 1024 * 1024,
    maxMarkdownChars: 200_000,
});

class DeckError extends Error {
    constructor(message, errorClass) {
        super(message);
        this.name = 'DeckError';
        this.errorClass = errorClass;
    }
}

// ── Small helpers ───────────────────────────────────────────────────────

/** Drop the inline markdown a slide would otherwise print literally. Links keep their text. */
function stripInlineMarkdown(text) {
    return String(text ?? '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/(?<![\w*])\*(?!\*)([^*\n]+?)\*(?![\w*])/g, '$1')
        .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim();
}

function clampText(value, max, warnings, what) {
    const s = stripInlineMarkdown(value);
    if (s.length <= max) return s;
    if (warnings) warnings.push(`${what} was shortened to ${max} characters`);
    return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Classify an image reference. Only two kinds survive: inline bytes and a
 * Bee Flow storage object (as a key, or as the proxy URL the chat hands out).
 */
function classifyImageRef(src, alt = '') {
    const raw = String(src ?? '').trim();
    if (!raw) return null;
    if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) {
        return { dataUrl: raw.replace(/\s+/g, ''), alt: String(alt || '') };
    }
    const proxy = /^(?:https?:\/\/[^/]+)?\/api\/storage\/file\/(.+)$/i.exec(raw);
    if (proxy) {
        let key;
        try { key = proxy[1].split('/').map(decodeURIComponent).join('/'); } catch { return { rejected: raw, alt: String(alt || '') }; }
        return { storageKey: key.replace(/^\/+/, ''), alt: String(alt || '') };
    }
    if (/^users\/[^/]+\/[^/]+\/.+/.test(raw) && !raw.includes('..')) {
        return { storageKey: raw, alt: String(alt || '') };
    }
    return { rejected: raw, alt: String(alt || '') };
}

// ── Block parser: markdown lines → the fields of ONE slide ─────────────

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

/** Assemble one normalised slide from parsed fields plus the explicit bits. */
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

function inferLayout(slide) {
    if (slide.chart) return 'chart';
    if (slide.stats) return 'stats';
    if (slide.steps) return 'timeline';
    if (slide.table) return 'table';
    if (slide.image) return 'image';
    if (slide.quote) return 'quote';
    if (slide.columns) return 'two_column';
    if (slide.cards) return 'cards';
    if (!slide.bullets.length && !slide.body && slide.title) return 'section';
    return 'bullets';
}

// ── Deck from markdown ──────────────────────────────────────────────────

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

// ── Deck from JSON ──────────────────────────────────────────────────────

function asBulletList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const b of value) {
        if (b === null || b === undefined) continue;
        if (typeof b === 'object' && !Array.isArray(b)) {
            const text = stripInlineMarkdown(b.text ?? b.label ?? b.title ?? '');
            if (text) out.push({ text, level: Number(b.level) >= 1 ? 1 : 0 });
            continue;
        }
        const raw = String(b);
        const indent = /^(\s+)/.exec(raw);
        const text = stripInlineMarkdown(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        if (text) out.push({ text, level: indent && indent[1].replace(/\t/g, '  ').length >= 2 ? 1 : 0 });
    }
    return out;
}

function asTable(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
        const rows = value.filter(Array.isArray).map((r) => r.map((c) => (c === null || c === undefined ? '' : c)));
        if (!rows.length) return null;
        return { columns: rows[0].map((c) => stripInlineMarkdown(c)), rows: rows.slice(1) };
    }
    if (typeof value === 'object') {
        const columns = Array.isArray(value.columns) ? value.columns.map((c) => stripInlineMarkdown(typeof c === 'object' && c ? (c.label ?? c.name ?? c.key ?? '') : c)) : [];
        let rows = Array.isArray(value.rows) ? value.rows : [];
        // Rows of objects are laid out under the columns (by key), like rowsToMatrix does.
        if (rows.length && rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
            const cols = columns.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
            return { columns: cols, rows: rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c]))) };
        }
        rows = rows.filter(Array.isArray);
        if (!columns.length && !rows.length) return null;
        return { columns, rows };
    }
    return null;
}

function asImage(value) {
    if (!value) return null;
    if (typeof value === 'string') return classifyImageRef(value);
    if (typeof value === 'object') {
        const src = value.dataUrl || value.data || value.url || value.src || value.storageKey || value.key || '';
        const ref = classifyImageRef(src, value.alt || value.caption || '');
        return ref;
    }
    return null;
}

function asQuote(value) {
    if (!value) return null;
    if (typeof value === 'string') return { lines: [stripInlineMarkdown(value)], attribution: null };
    if (typeof value === 'object') {
        const text = stripInlineMarkdown(value.text ?? value.quote ?? '');
        return text ? { lines: [text], attribution: value.attribution ? stripInlineMarkdown(value.attribution) : null } : null;
    }
    return null;
}

function slideFromJson(input, warnings) {
    if (typeof input === 'string') {
        const f = fieldsFromContent(input);
        return slideFromFields('', f, { warnings });
    }
    const s = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {}); // untrusted input, any shape
    // `content` (a slide node's markdown) and `text`/`markdown` are parsed like
    // a slide body; the structured fields override what parsing found.
    const f = fieldsFromContent(s.content ?? s.text ?? s.markdown ?? s.body ?? '');
    if (typeof s.body === 'string' && (s.content !== undefined || s.text !== undefined || s.markdown !== undefined)) {
        f.body.push(...String(s.body).split('\n'));
    }
    const bullets = asBulletList(s.bullets ?? s.points ?? s.items);
    if (bullets.length) f.bullets = bullets;
    const table = asTable(s.table);
    if (table) f.table = table;
    const quote = asQuote(s.quote);
    if (quote) f.quote = quote;
    const image = asImage(s.image);
    if (image && image.rejected) {
        warnings.push(`remote image "${image.rejected.slice(0, 80)}" was skipped — only Bee Flow storage or data: images can be placed on a slide`);
    }
    // `cards` (3–4 titled texts), or `columns` given with three or four entries.
    const cardsIn = Array.isArray(s.cards) && s.cards.length ? s.cards : (Array.isArray(s.columns) && s.columns.length >= 3 ? s.columns : null);
    if (cardsIn) {
        f.columns = cardsIn.slice(0, MAX_CARDS).map((c) => {
            if (typeof c === 'string') { const cf = fieldsFromContent(c); return { title: '', bullets: cf.bullets, body: cf.body }; }
            const cc = c && typeof c === 'object' ? c : {};
            const cf = fieldsFromContent(cc.text ?? cc.content ?? cc.body ?? '');
            const cb = asBulletList(cc.bullets ?? cc.items);
            const img = asImage(cc.image);
            if (img && img.rejected) warnings.push(`remote image "${img.rejected.slice(0, 80)}" was skipped — only Bee Flow storage or data: images can be placed on a slide`);
            return { title: stripInlineMarkdown(cc.title ?? cc.heading ?? cc.label ?? ''), bullets: cb.length ? cb : cf.bullets, body: cf.body, icon: cc.icon ? String(cc.icon) : null, image: img && !img.rejected ? img : (cf.image || null) };
        });
    } else if (Array.isArray(s.columns) && s.columns.length) {
        f.columns = s.columns.slice(0, 2).map((c) => {
            if (typeof c === 'string') { const cf = fieldsFromContent(c); return { title: '', bullets: cf.bullets, body: cf.body }; }
            const cc = c && typeof c === 'object' ? c : {};
            const cf = fieldsFromContent(cc.content ?? cc.text ?? '');
            const cb = asBulletList(cc.bullets ?? cc.items);
            return { title: stripInlineMarkdown(cc.title ?? cc.heading ?? ''), bullets: cb.length ? cb : cf.bullets, body: cf.body };
        });
    }
    const layout = typeof s.layout === 'string' ? s.layout.trim().toLowerCase().replace(/-/g, '_') : null;
    const explicitNotes = typeof s.notes === 'string' ? s.notes : (typeof s.speakerNotes === 'string' ? s.speakerNotes : null);
    // Visuals: `chart` is the model or a {type, data, labels?, values?} wrapper
    // (data = rows, a matrix, a table, a markdown table, "label: n" lines);
    // `chart:"bar"` alone means "chart the table". `stats` = tiles, `steps` /
    // `timeline` = process steps, `style` = the slide's tint.
    let chart = null;
    if (typeof s.chart === 'string' && !/[\n:{[|]/.test(s.chart)) {
        if (f.table) { chart = chartFromAny({ columns: f.table.columns, rows: f.table.rows }, { type: s.chart }, warnings); if (chart) f.table = null; }
        else warnings.push('`chart` names a type but the slide has no table or data');
    } else if (s.chart !== undefined && s.chart !== null && s.chart !== '') {
        chart = chartFromAny(s.chart, {}, warnings);
    }
    const stats = s.stats !== undefined && s.stats !== null && s.stats !== '' ? statsFromAny(s.stats, warnings) : null;
    if (stats) for (const t of stats) { if (t.icon) { const n = normaliseIconName(t.icon); if (!n) warnings.push(`unknown icon "${t.icon}" was skipped`); t.icon = n; } }
    const stepsIn = s.steps ?? s.timeline;
    const steps = stepsIn !== undefined && stepsIn !== null && stepsIn !== '' ? stepsFromAny(stepsIn, warnings) : null;
    return slideFromFields(s.title ?? s.heading ?? '', f, {
        layout: layout && layout !== 'auto' ? layout : null,
        notes: explicitNotes,
        image: image && !image.rejected ? image : null,
        chart,
        stats: stats && stats.length ? stats : null,
        steps,
        style: s.style,
        warnings,
    });
}

function deckFromJson(obj, warnings) {
    const d = obj && typeof obj === 'object' ? obj : {};
    const slidesIn = Array.isArray(d.slides) ? d.slides : [];
    const deck = {
        title: stripInlineMarkdown(d.title ?? ''),
        subtitle: d.subtitle ? stripInlineMarkdown(d.subtitle) : null,
        author: d.author ? stripInlineMarkdown(d.author) : null,
        date: d.date ? String(d.date).trim().slice(0, 40) : null,
        slides: [],
    };
    if (typeof d.markdown === 'string' && d.markdown.trim() && !slidesIn.length) {
        const fromMd = deckFromMarkdown(d.markdown, warnings);
        deck.slides = fromMd.slides;
        if (!deck.title) deck.title = fromMd.title;
        if (!deck.subtitle) deck.subtitle = fromMd.subtitle;
        if (fromMd.coverNotes) deck.coverNotes = fromMd.coverNotes;
        return deck;
    }
    for (const s of slidesIn) {
        if (s === null || s === undefined) continue;
        deck.slides.push(slideFromJson(s, warnings));
    }
    return deck;
}

// ── Clamp ───────────────────────────────────────────────────────────────

function clampSlide(slide, index, limits, warnings) {
    const label = `slide ${index + 1}`;
    slide.title = clampText(slide.title, limits.maxTitleChars, warnings, `${label}: the title`);
    slide.bullets = slide.bullets.map((b) => ({ text: clampText(b.text, limits.maxBulletChars, warnings, `${label}: a bullet`), level: b.level ? 1 : 0 }))
        .filter((b) => b.text);
    if (slide.body) slide.body = clampText(slide.body, limits.maxBodyChars, warnings, `${label}: the text`) || null;
    if (slide.notes) slide.notes = clampText(slide.notes, limits.maxNotesChars, warnings, `${label}: the speaker notes`) || null;
    if (slide.quote) {
        slide.quote.text = clampText(slide.quote.text, limits.maxQuoteChars, warnings, `${label}: the quote`);
        if (slide.quote.attribution) slide.quote.attribution = clampText(slide.quote.attribution, limits.maxTitleChars, warnings, `${label}: the attribution`);
        if (!slide.quote.text) slide.quote = null;
    }
    if (slide.cards) {
        slide.cards = slide.cards.slice(0, MAX_CARDS).map((c) => ({
            title: c.title ? clampText(c.title, limits.maxTitleChars, warnings, `${label}: a card title`) : null,
            text: c.text ? clampText(c.text, 320, warnings, `${label}: a card`) : null,
            icon: c.icon || null,
            image: c.image || null,
        })).filter((c) => c.title || c.text || c.image);
        if (slide.cards.length < 2) slide.cards = null;
    }
    if (slide.columns) {
        slide.columns = slide.columns.map((c) => ({
            title: c.title ? clampText(c.title, limits.maxTitleChars, warnings, `${label}: a column title`) : null,
            bullets: c.bullets.slice(0, limits.maxBulletsPerSlide).map((b) => ({ text: clampText(b.text, limits.maxBulletChars, warnings, `${label}: a bullet`), level: b.level ? 1 : 0 })).filter((b) => b.text),
        }));
        if (slide.columns.some((c) => c.bullets.length < 1 && !c.title)) slide.columns = null;
    }
    if (slide.table) {
        const t = slide.table;
        const cols = t.columns.slice(0, limits.maxTableCols).map((c) => clampText(c, limits.maxCellChars, null));
        if (t.columns.length > limits.maxTableCols) warnings.push(`${label}: the table was cut to ${limits.maxTableCols} columns`);
        if (t.rows.length > limits.maxTableRows) warnings.push(`${label}: the table was cut to ${limits.maxTableRows} rows`);
        const width = cols.length || (t.rows[0] ? Math.min(t.rows[0].length, limits.maxTableCols) : 0);
        const rows = t.rows.slice(0, limits.maxTableRows).map((r) => {
            const out = [];
            for (let i = 0; i < width; i += 1) {
                const v = r[i];
                out.push(typeof v === 'number' && Number.isFinite(v) ? v : clampText(v === undefined || v === null ? '' : String(v), limits.maxCellChars, null));
            }
            return out;
        });
        slide.table = width ? { columns: cols.length ? cols : new Array(width).fill(''), rows } : null;
    }
    if (slide.image && slide.image.dataUrl) {
        const b64 = slide.image.dataUrl.slice(slide.image.dataUrl.indexOf(',') + 1);
        if (Math.floor(b64.length * 3 / 4) > limits.maxImageBytes) {
            warnings.push(`${label}: the image is larger than ${Math.round(limits.maxImageBytes / 1048576)} MB and was skipped`);
            slide.image = null;
        }
    }
    // Visuals arrive already capped by deckChart; a chart without a number is
    // no chart, and a layout naming a visual the slide lacks is re-inferred.
    if (slide.chart && !(Array.isArray(slide.chart.series) && slide.chart.series.some((s) => s.values.some((v) => typeof v === 'number')))) slide.chart = null;
    if (slide.stats && !slide.stats.length) slide.stats = null;
    if (slide.steps && !slide.steps.length) slide.steps = null;
    slide.style = slideStyle(slide.style);
    if (!SLIDE_LAYOUTS.includes(slide.layout) || (slide.layout === 'table' && !slide.table) || (slide.layout === 'image' && !slide.image)
        || (slide.layout === 'quote' && !slide.quote) || (slide.layout === 'two_column' && !slide.columns) || (slide.layout === 'cards' && !slide.cards)
        || (slide.layout === 'chart' && !slide.chart) || (slide.layout === 'stats' && !slide.stats) || (slide.layout === 'timeline' && !slide.steps)) {
        slide.layout = inferLayout(slide);
    }
    return slide;
}

function isEmptySlide(s) {
    return !s.title && !s.bullets.length && !s.body && !s.table && !s.image && !s.quote && !s.columns && !s.cards && !s.notes && !s.chart && !s.stats && !s.steps;
}

/** Split a slide whose bullet list overflows into continuation slides. */
function splitOverflow(slide, limits, warnings, index) {
    if (slide.bullets.length <= limits.maxBulletsPerSlide) return [slide];
    const chunks = [];
    for (let i = 0; i < slide.bullets.length; i += limits.maxBulletsPerSlide) {
        chunks.push(slide.bullets.slice(i, i + limits.maxBulletsPerSlide));
    }
    warnings.push(`slide ${index + 1}: ${slide.bullets.length} bullets were split over ${chunks.length} slides`);
    return chunks.map((bullets, n) => ({
        ...slide,
        title: n === 0 ? slide.title : `${slide.title} (${n + 1})`,
        bullets,
        body: n === 0 ? slide.body : null,
        table: n === 0 ? slide.table : null,
        image: n === 0 ? slide.image : null,
        quote: n === 0 ? slide.quote : null,
        chart: n === 0 ? slide.chart : null,
        stats: n === 0 ? slide.stats : null,
        steps: n === 0 ? slide.steps : null,
        cards: n === 0 ? slide.cards : null,
        notes: n === 0 ? slide.notes : null,
        layout: n === 0 ? slide.layout : 'bullets',
    }));
}

function clampDeck(deck, limits, warnings) {
    deck.title = clampText(deck.title, limits.maxTitleChars, warnings, 'the deck title');
    if (deck.subtitle) deck.subtitle = clampText(deck.subtitle, limits.maxSubtitleChars, warnings, 'the subtitle') || null;
    if (deck.author) deck.author = clampText(deck.author, limits.maxTitleChars, null) || null;
    if (deck.coverNotes) deck.coverNotes = clampText(deck.coverNotes, limits.maxNotesChars, warnings, 'the cover notes') || null;

    const slides = [];
    deck.slides.forEach((s, i) => {
        const clamped = clampSlide(s, i, limits, warnings);
        if (isEmptySlide(clamped)) return;
        for (const part of splitOverflow(clamped, limits, warnings, i)) slides.push(part);
    });
    if (slides.length > limits.maxSlides) {
        throw new DeckError(`The deck has ${slides.length} slides; the limit is ${limits.maxSlides}.`, 'deck_too_large');
    }
    if (!slides.length && !deck.title) {
        throw new DeckError('There are no slides to put in the presentation.', 'deck_empty');
    }
    deck.slides = slides;
    return deck;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Normalise ANY deck input into the model above.
 *
 * @param {string|object} input  markdown, or `{ title, subtitle?, slides:[…] }`, or `{ markdown }`
 * @returns {{ title:string, subtitle:string|null, author:string|null, date:string|null, slides:object[], warnings:string[] }}
 */
function normalizeDeck(input, { limits = DECK_LIMITS } = {}) {
    const warnings = [];
    let deck;
    if (typeof input === 'string') {
        if (!input.trim()) throw new DeckError('There are no slides to put in the presentation.', 'deck_empty');
        deck = deckFromMarkdown(input, warnings);
    } else if (input && typeof input === 'object' && (Array.isArray(input.slides) || typeof input.markdown === 'string')) {
        deck = deckFromJson(input, warnings);
    } else if (Array.isArray(input)) {
        deck = deckFromJson({ slides: input }, warnings);
    } else {
        throw new DeckError('A deck is a markdown outline or an object with a `slides` array.', 'deck_invalid');
    }
    clampDeck(deck, limits, warnings);
    deck.warnings = warnings;
    // Renderers accept a raw deck too; this flag lets them skip a second pass.
    Object.defineProperty(deck, 'normalized', { value: true, enumerable: false });
    return deck;
}

/** One slide, normalised the way normalizeDeck would — for the automation `slide` step. */
function normalizeSlide(input, { limits = DECK_LIMITS } = {}) {
    const warnings = [];
    const slide = slideFromJson(input, warnings);
    const clamped = clampSlide(slide, 0, limits, warnings);
    return { slide: clamped, warnings };
}

function deckSlideCount(deck) {
    return deck && Array.isArray(deck.slides) ? deck.slides.length : 0;
}

/**
 * The JSON-schema `properties` every tool that accepts a deck spreads into its
 * parameters, so the chat tool, the Nextcloud tool and the builders cannot
 * drift apart in what they teach the model.
 */
const SLIDE_INPUT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        title: { type: 'string', description: 'Slide heading.' },
        bullets: { type: 'array', items: { type: 'string' }, description: 'Up to 10 short points. Start an item with two spaces for a sub-point.' },
        body: { type: 'string', description: 'A short paragraph instead of, or above, the bullets.' },
        notes: { type: 'string', description: 'Speaker notes — what the presenter says, not what the audience reads.' },
        layout: { type: 'string', enum: [...SLIDE_LAYOUTS], description: 'Optional. Picked from the content when omitted.' },
        table: { type: 'object', description: '{ "columns": ["…"], "rows": [["…"]] } — max 8 columns, 15 rows.' },
        quote: { type: 'object', description: '{ "text": "…", "attribution": "…" }.' },
        image: { type: 'object', description: '{ "url": "…", "alt": "…" } — a Bee Flow storage URL (e.g. from generate_image) or a data: URL. Remote http(s) images are not fetched.' },
        columns: { type: 'array', items: { type: 'object' }, description: 'Exactly two: [{ "title": "…", "bullets": ["…"] }, { … }] for a two-column slide.' },
        cards: { type: 'array', items: { type: 'object' }, description: 'Two to six cards: [{ "title": "Wi-Fi off", "text": "one or two sentences", "icon"?: "wifi-off", "image"?: { "url": "…" } }, …]. Icons are Lucide names (shield, users, workflow, chart-line, lock, cloud-off, rocket…).' },
        chart: { type: 'object', description: `A chart: { "type": "${CHART_TYPES.join('|')}", "labels": ["Q1","Q2"], "series": [{ "name": "Omzet", "values": [10, 20] }], "unit"?: "%", "stacked"?: true } — or { "type", "data": rows } with the columns auto-detected. Pie/donut take one series.` },
        stats: { type: 'array', items: { type: 'object' }, description: 'KPI tiles, max 4: [{ "value": "€ 1,2M", "label": "Omzet", "delta"?: "+12%", "icon"?: "trending-up" }].' },
        steps: { type: 'array', items: { type: 'object' }, description: 'A timeline / process, max 6: [{ "title": "Kick-off", "text"?: "…" }].' },
        style: { type: 'string', enum: [...SLIDE_STYLES], description: 'Paint this one slide in the accent colour or dark — for emphasis; leave out otherwise.' },
    },
});

const DECK_INPUT_PROPERTIES = Object.freeze({
    title: { type: 'string', description: 'The deck title — the cover slide.' },
    subtitle: { type: 'string', description: 'Optional cover subtitle (audience, date, author).' },
    slides: { type: 'array', items: SLIDE_INPUT_SCHEMA, description: 'The slides in order. Prefer 3–6 bullets per slide and add speaker notes.' },
    markdown: { type: 'string', description: 'Instead of `slides`: a markdown outline — "# " title once, "## " per slide, "- " bullets (two-space indent = sub-point), "> " quote, a "|" table, "![alt](url)" image, "### " sub-headings (two = columns, three to six = cards; "### Title {icon: shield}" gives a card an icon, an image line inside the block its picture), "<!-- notes: … -->" speaker notes. Visuals: a ```chart block ("type: bar", "labels: Q1, Q2", "Omzet: 10, 20"), "<!-- chart: bar -->" above a table, a ```stats block ("€ 1,2M | Omzet | +12%" per line), "<!-- layout: timeline -->" for steps, "<!-- style: accent -->" for an emphasis slide.' },
});

// ── Deck → markdown ─────────────────────────────────────────────────────

/** A text that must stay ONE line of the outline (a title, a label, a cell). */
function mdLine(text) {
    return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A comment's payload: the closing marker cannot appear inside it. */
function mdComment(kind, text) {
    return `<!-- ${kind}: ${String(text ?? '').replace(/-->/g, '- - >').trim()} -->`;
}

/** An image reference as the grammar reads it back (a storage key or data: URL). */
function mdImageRef(image) {
    if (!image) return null;
    // The storage key first: a rendered deck carries the resolved bytes in
    // `dataUrl` as well, and an outline should reference the file, not embed it.
    if (image.storageKey) return image.storageKey;
    if (image.dataUrl) return image.dataUrl;
    return null;
}

/** "a, b, c" — or "; "-separated when a label carries a comma. */
function mdList(values) {
    const items = values.map((v) => mdLine(v === null || v === undefined ? '' : v));
    const sep = items.some((x) => x.includes(',')) ? '; ' : ', ';
    return items.join(sep);
}

function mdBullets(bullets) {
    return bullets.map((b) => `${b.level ? '  ' : ''}- ${mdLine(b.text)}`);
}

/**
 * The markdown outline for a normalised deck — the inverse of deckFromMarkdown,
 * as far as the grammar reaches: what a person edits in the Documents library
 * (core/documents/deckDocument.js keeps a presentation as this text), and what
 * a deck that arrived as JSON becomes so it can be edited at all.
 *
 * Round-trip contract (tested): normalizeDeck(deckToMarkdown(deck)) yields the
 * same slides — layouts, visuals, cards, notes and styles included. A layout
 * comment is written only when the grammar would infer another one, so a
 * plain bullet slide reads as plain markdown.
 */
function deckToMarkdown(deck) {
    const d = deck && deck.normalized ? deck : normalizeDeck(deck);
    const out = [];
    if (d.title) out.push(`# ${mdLine(d.title)}`, '');
    if (d.subtitle) out.push(mdLine(d.subtitle), '');
    if (d.coverNotes) out.push(mdComment('notes', d.coverNotes), '');
    for (const s of d.slides) {
        out.push(s.title ? `## ${mdLine(s.title)}` : '---');
        // The grammar infers most layouts; a timeline (bullets read as steps)
        // and a PAIR of cards (two ### blocks read as columns) need the hint.
        if (s.layout && (s.layout !== inferLayout(s) || s.layout === 'timeline' || (s.layout === 'cards' && (s.cards || []).length === 2))) out.push(mdComment('layout', s.layout));
        if (s.style) out.push(mdComment('style', s.style));
        if (s.body) out.push(...String(s.body).split('\n'));
        const image = mdImageRef(s.image);
        if (image) out.push(`![${mdLine(s.image.alt || '')}](${image})`);
        if (s.table) {
            const cols = s.table.columns.map((c) => mdLine(c).replace(/\|/g, '/'));
            out.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`);
            for (const r of s.table.rows) out.push(`| ${r.map((v) => mdLine(v ?? '').replace(/\|/g, '/')).join(' | ')} |`);
        }
        if (s.chart) {
            const c = s.chart;
            out.push('```chart', `type: ${c.type}`);
            if (c.title) out.push(`title: ${mdLine(c.title)}`);
            if (c.unit) out.push(`unit: ${mdLine(c.unit)}`);
            if (c.stacked) out.push('stacked: true');
            if (c.showValues === false) out.push('showValues: false');
            out.push(`labels: ${mdList(c.labels)}`);
            c.series.forEach((ser, i) => out.push(`${mdLine(ser.name || `Series ${i + 1}`).replace(/:/g, ' ')}: ${mdList(ser.values)}`));
            out.push('```');
        }
        if (s.stats) {
            out.push('```stats');
            for (const t of s.stats) out.push([t.value, t.label || '', t.delta || '', t.icon || ''].map(mdLine).join(' | ').replace(/(\s*\|\s*)+$/, ''));
            out.push('```');
        }
        // A timeline's steps are bullets in "Title — text" form; when the bullets
        // are the steps (the usual case) they are written once.
        if (s.steps && !s.bullets.length) out.push(...s.steps.map((st) => `- ${mdLine(st.title)}${st.text ? ` — ${mdLine(st.text)}` : ''}`));
        else if (s.bullets.length && !(s.quote && s.layout === 'quote' && !s.bullets.length)) out.push(...mdBullets(s.bullets));
        if (s.quote) {
            out.push(`> ${mdLine(s.quote.text)}`);
            if (s.quote.attribution) out.push(`> — ${mdLine(s.quote.attribution)}`);
        }
        for (const col of s.columns || []) {
            out.push(`### ${mdLine(col.title || '')}`.trimEnd());
            out.push(...mdBullets(col.bullets || []));
        }
        for (const card of s.cards || []) {
            out.push(`### ${mdLine(card.title || '')}${card.icon ? ` {icon: ${card.icon}}` : ''}`.trimEnd());
            const pic = mdImageRef(card.image);
            if (pic) out.push(`![${mdLine(card.image.alt || '')}](${pic})`);
            if (card.text) out.push(...String(card.text).split('\n').map((l) => l.trim()).filter(Boolean));
        }
        if (s.notes) out.push(mdComment('notes', s.notes));
        out.push('');
    }
    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

module.exports = {
    SLIDE_LAYOUTS,
    CHART_TYPES,
    SLIDE_STYLES,
    DECK_LIMITS,
    DECK_INPUT_PROPERTIES,
    SLIDE_INPUT_SCHEMA,
    DeckError,
    normalizeDeck,
    normalizeSlide,
    deckSlideCount,
    deckToMarkdown,
    classifyImageRef,
    stripInlineMarkdown,
    _test: { deckFromMarkdown, deckFromJson, parseSlideLines, fieldsFromContent, clampDeck, inferLayout },
};
