/**
 * Deck model — the one shape every presentation surface agrees on.
 *
 * A deck comes in as either a MARKDOWN outline (what an ai_step or a chat
 * model writes most naturally) or a JSON deck (what a tool call or an automation
 * binding produces), and leaves as one normalised structure that both the
 * .pptx builder (core/documents/office/officegen.js) and the PDF deck renderer
 * (core/documents/render/documentRenderer.js deckToSlidesHtml) consume. The renderers never
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

const { CHART_TYPES, SLIDE_STYLES } = require('./deckChart');
const { SLIDE_LAYOUTS, DECK_LIMITS, DeckError, stripInlineMarkdown, classifyImageRef, inferLayout } = require('./deckBase');
const { clampSlide, clampDeck } = require('./deckClamp');
const { parseSlideLines, fieldsFromContent, deckFromMarkdown } = require('./deckParse');
const { slideFromJson, deckFromJson } = require('./deckJson');

// ── Small helpers ───────────────────────────────────────────────────────

// ── Block parser: markdown lines → the fields of ONE slide ─────────────

// ── Deck from markdown ──────────────────────────────────────────────────

// ── Deck from JSON ──────────────────────────────────────────────────────

// ── Clamp ───────────────────────────────────────────────────────────────

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

/**
 * A comment's payload: the closing marker cannot appear inside it.
 * @param {string} kind
 */
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
    const sep = items.some((/** @type {string | string[]} */ x) => x.includes(',')) ? '; ' : ', ';
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

/**
 * @typedef {{ text: string, level: number }} BulletItem
 * @typedef {{ dataUrl?: string, storageKey?: string, rejected?: string, alt: string }} ImageRef
 * @typedef {{ columns: string[], rows: unknown[][] }} SlideTable
 * @typedef {{ title: string, bullets: BulletItem[], body: string[], icon?: string | null, image?: ImageRef | null }} ParsedColumn
 * @typedef {NonNullable<ReturnType<typeof chartFromAny>>} SlideChart
 * @typedef {ReturnType<typeof statsFromAny>[number]} SlideStat
 * @typedef {ReturnType<typeof stepsFromAny>[number]} SlideStep
 * @typedef {ReturnType<typeof cardFrom>} SlideCard
 * @typedef {{ layout: string | null, title: string, bullets: BulletItem[], columns: { title: string | null, bullets: BulletItem[] }[] | null,
 *   body: string | null, table: SlideTable | null, image: ImageRef | null, quote: { text: string, attribution: string | null } | null,
 *   chart: SlideChart | null, stats: SlideStat[] | null, steps: SlideStep[] | null, cards: SlideCard[] | null,
 *   style: string | null, notes: string | null }} Slide
 * @typedef {{ title: string, subtitle: string | null, author: string | null, date: string | null, slides: Slide[],
 *   coverNotes?: string | null, warnings?: string[], normalized?: boolean }} Deck
 */
