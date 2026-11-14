// @typecheck
const { chartFromAny, statsFromAny, stepsFromAny } = require('./deckChart');
const { MAX_CARDS, stripInlineMarkdown, classifyImageRef } = require('./deckBase');
const { fieldsFromContent, slideFromFields, deckFromMarkdown } = require('./deckParse');
const { resolveStatIcons } = require('./deckSlideAssembly');

function asBulletList(value) {
    if (!Array.isArray(value)) return [];
    /** @type {{ text: string; level: number; }[]} */
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

/** @param {unknown} v */
const given = (v) => v !== undefined && v !== null && v !== '';

/**
 * The image a slide or card may keep; a remote one is a warning and nothing.
 * @param {unknown} value
 * @param {string[]} warnings
 */
function usableImage(value, warnings) {
    const image = asImage(value);
    if (!image || !image.rejected) return image;
    warnings.push(`remote image "${image.rejected.slice(0, 80)}" was skipped — only Bee Flow storage or data: images can be placed on a slide`);
    return null;
}

/**
 * The parsed fields of a JSON slide: `content` (a slide node's markdown) and
 * `text`/`markdown`/`body` are parsed like a slide body; the structured
 * fields override what parsing found.
 * @param {Record<string, any>} s
 */
function fieldsFromJson(s) {
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
    return f;
}

/**
 * One entry of `cards` (or of `columns` given with three or more entries).
 * @param {unknown} c
 * @param {string[]} warnings
 */
function cardColumn(c, warnings) {
    if (typeof c === 'string') { const cf = fieldsFromContent(c); return { title: '', bullets: cf.bullets, body: cf.body }; }
    const cc = /** @type {Record<string, any>} */ (c && typeof c === 'object' ? c : {});
    const cf = fieldsFromContent(cc.text ?? cc.content ?? cc.body ?? '');
    const cb = asBulletList(cc.bullets ?? cc.items);
    const img = usableImage(cc.image, warnings);
    return { title: stripInlineMarkdown(cc.title ?? cc.heading ?? cc.label ?? ''), bullets: cb.length ? cb : cf.bullets, body: cf.body, icon: cc.icon ? String(cc.icon) : null, image: img || cf.image || null };
}

/**
 * One of the two entries of a `columns` pair.
 * @param {unknown} c
 */
function pairColumn(c) {
    if (typeof c === 'string') { const cf = fieldsFromContent(c); return { title: '', bullets: cf.bullets, body: cf.body }; }
    const cc = /** @type {Record<string, any>} */ (c && typeof c === 'object' ? c : {});
    const cf = fieldsFromContent(cc.content ?? cc.text ?? '');
    const cb = asBulletList(cc.bullets ?? cc.items);
    return { title: stripInlineMarkdown(cc.title ?? cc.heading ?? ''), bullets: cb.length ? cb : cf.bullets, body: cf.body };
}

/**
 * `cards` (titled texts), or `columns` given with three or more entries, else
 * a `columns` pair; null when the slide names neither.
 * @param {Record<string, any>} s
 * @param {string[]} warnings
 */
function columnsFromJson(s, warnings) {
    const cardsIn = Array.isArray(s.cards) && s.cards.length ? s.cards : (Array.isArray(s.columns) && s.columns.length >= 3 ? s.columns : null);
    if (cardsIn) return cardsIn.slice(0, MAX_CARDS).map((/** @type {unknown} */ c) => cardColumn(c, warnings));
    if (Array.isArray(s.columns) && s.columns.length) return s.columns.slice(0, 2).map(pairColumn);
    return null;
}

/** `chart: "bar"` alone names a type: no data, no "label: n" lines, no JSON. @param {unknown} chart */
const namesChartType = (chart) => typeof chart === 'string' && !/[\n:{[|]/.test(chart);

/**
 * `chart` is the model or a {type, data, labels?, values?} wrapper (data =
 * rows, a matrix, a table, a markdown table, "label: n" lines); a bare type
 * means "chart the table", which then is the chart's data and no longer a table.
 * @param {Record<string, any>} s
 * @param {ReturnType<typeof fieldsFromContent>} f
 * @param {string[]} warnings
 */
function chartFromJson(s, f, warnings) {
    if (!namesChartType(s.chart)) return given(s.chart) ? chartFromAny(s.chart, {}, warnings) : null;
    if (!f.table) { warnings.push('`chart` names a type but the slide has no table or data'); return null; }
    const chart = chartFromAny({ columns: f.table.columns, rows: f.table.rows }, { type: s.chart }, warnings);
    if (chart) f.table = null;
    return chart;
}

/** @param {Record<string, any>} s */
function layoutFromJson(s) {
    const layout = typeof s.layout === 'string' ? s.layout.trim().toLowerCase().replace(/-/g, '_') : null;
    return layout && layout !== 'auto' ? layout : null;
}

/** @param {Record<string, any>} s */
function notesFromJson(s) {
    if (typeof s.notes === 'string') return s.notes;
    return typeof s.speakerNotes === 'string' ? s.speakerNotes : null;
}

/**
 * One slide from a JSON slide (or a string of slide markdown). `stats` are
 * tiles, `steps` / `timeline` process steps, `style` the slide's tint.
 * @param {unknown} input
 * @param {string[]} warnings
 */
function slideFromJson(input, warnings) {
    if (typeof input === 'string') {
        const f = fieldsFromContent(input);
        return slideFromFields('', f, { warnings });
    }
    const s = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {}); // untrusted input, any shape
    const f = fieldsFromJson(s);
    const image = usableImage(s.image, warnings);
    const columns = columnsFromJson(s, warnings);
    if (columns) f.columns = columns;
    const chart = chartFromJson(s, f, warnings);
    const stats = given(s.stats) ? resolveStatIcons(statsFromAny(s.stats, warnings), warnings) : null;
    const stepsIn = s.steps ?? s.timeline;
    return slideFromFields(s.title ?? s.heading ?? '', f, {
        layout: layoutFromJson(s),
        notes: notesFromJson(s),
        image,
        chart,
        stats: stats && stats.length ? stats : null,
        steps: given(stepsIn) ? stepsFromAny(stepsIn, warnings) : null,
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

module.exports = { slideFromJson, deckFromJson };
