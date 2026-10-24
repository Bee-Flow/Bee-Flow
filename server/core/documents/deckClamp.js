const { slideStyle } = require('./deckChart');
const { SLIDE_LAYOUTS, MAX_CARDS, DeckError, clampText, inferLayout } = require('./deckBase');

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
        if (isEmptySlide(clamped)) { warnings.push(`slide ${i + 1} was empty and was skipped`); return; }
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

module.exports = { clampSlide, clampDeck };
