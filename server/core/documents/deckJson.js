// @typecheck
const { chartFromAny, statsFromAny, stepsFromAny } = require('./deckChart');
const { normaliseIconName } = require('./deckIcons');
const { MAX_CARDS, stripInlineMarkdown, classifyImageRef } = require('./deckBase');
const { fieldsFromContent, slideFromFields, deckFromMarkdown } = require('./deckParse');

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

module.exports = { slideFromJson, deckFromJson };
