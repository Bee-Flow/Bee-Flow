/**
 * The slides layout — a markdown memorandum rendered as a landscape deck.
 *
 * The contract under test is the SPLIT, because that is what an author steers
 * with: the h1 becomes the cover, every h2 becomes one slide whose text is the
 * band title, and nothing an author wrote may be dropped on the floor.
 *
 * Run: node --test --test-force-exit services/documentRenderer.slides.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { _test, LAYOUTS } = require('./documentRenderer');
const { toHtml, buildSlidesHtml } = _test;

const MD = `# Financieringsmemorandum Testbedrijf

Een preambule die niet mag verdwijnen.

## Begeleidende brief

Beste Johan,

## Financiële analyse — resultatenrekening

| Regel | 2025 |
|---|---|
| Omzet | 25.367 |

## Risico's en mitigatie

- Risico een
`;

function render(md = MD, meta = { title: 'Testdeck' }) {
    return buildSlidesHtml(toHtml(md, 'markdown'), meta);
}

test('the layout vocabulary is closed and known', () => {
    assert.deepStrictEqual([...LAYOUTS], ['document', 'slides']);
});

test('the h1 becomes the cover block', () => {
    const html = render();
    assert.match(html, /class="cover-title">Financieringsmemorandum Testbedrijf/);
    // The document title appears as a band exactly once — on the preamble
    // slide, which deliberately reuses it. Never on the section slides.
    const asBand = (html.match(/band-title">Financieringsmemorandum Testbedrijf/g) || []).length;
    assert.strictEqual(asBand, 1, 'only the preamble slide borrows the title');
});

test('every h2 becomes exactly one slide with that text as its band', () => {
    const html = render();
    for (const t of ['Begeleidende brief', 'Financiële analyse — resultatenrekening', "Risico's en mitigatie"]) {
        assert.ok(html.includes(`class="band-title">${t.replace(/'/g, '&#39;')}`) || html.includes(`class="band-title">${t}`),
            `band for "${t}"`);
    }
    // Cover + preamble slide + three sections.
    assert.strictEqual((html.match(/<section class="slide/g) || []).length, 5);
});

test('a preamble between the h1 and the first h2 survives on its own page', () => {
    assert.match(render(), /Een preambule die niet mag verdwijnen\./);
});

test('table content comes through inside the slide body', () => {
    const html = render();
    assert.match(html, /<td>Omzet<\/td>/);
    assert.match(html, /25\.367/);
});

test('a document with no h2s at all still yields a cover and one content page', () => {
    const html = render('# Alleen een titel\n\nEn een alinea.');
    assert.match(html, /class="cover-title">Alleen een titel/);
    assert.match(html, /En een alinea\./);
});

test('the brand mark comes from the theme and is on every content slide', () => {
    const themed = buildSlidesHtml(toHtml(MD, 'markdown'), { title: 'Testdeck', theme: { brandName: 'R & R', accent: '#A03B3B' } });
    const bands = (themed.match(/class="brand">R &amp; R</g) || []).length;
    assert.strictEqual(bands, 4, 'preamble slide + three sections');
    assert.match(themed, /--deck-accent: #A03B3B/);

    // No theme: no brand mark, the neutral accent, and no leftover watermark.
    const plain = render();
    assert.strictEqual((plain.match(/class="brand"/g) || []).length, 0);
    assert.match(plain, /--deck-accent: #123A5E/);
    assert.doesNotMatch(plain, /class="amp"/);
});

test('a theme logo lands on the cover and the footer text on every page', () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const html = buildSlidesHtml(toHtml(MD, 'markdown'), { title: 'T', theme: { logoDataUrl: logo, footerText: 'Vertrouwelijk' } });
    assert.match(html, new RegExp(`<img class="cover-logo" src="${logo}"`));
    assert.match(html, /class="deck-footer">Vertrouwelijk</);
});

test('deckToSlidesHtml renders a normalised deck with the same band contract', () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const deck = normalizeDeck({ title: 'Deck', subtitle: 'Sub', slides: [
        { title: 'Bullets', bullets: ['a', '  b'] },
        { title: 'Table', table: { columns: ['x', 'y'], rows: [[1, 2]] } },
        { title: 'Quote', quote: { text: 'q', attribution: 'me' } },
        { title: 'Cols', columns: [{ title: 'L', bullets: ['l'] }, { title: 'R', bullets: ['r'] }] },
        { title: 'Break', layout: 'section' },
        { title: 'Bye', layout: 'closing', body: 'mail@example.test' },
    ] });
    const html = _test.deckToSlidesHtml(deck, { theme: { brandName: 'Bee', accent: '#112233' }, title: '' });
    assert.match(html, /class="cover-title">Deck</);
    assert.match(html, /class="cover-sub">Sub</);
    assert.strictEqual((html.match(/class="band-title">/g) || []).length, 4, 'bullets, table, quote, cols');
    assert.match(html, /<li>a<\/li><li style="margin-left:6mm">b<\/li>/);
    assert.match(html, /<th>x<\/th><th>y<\/th>/);
    assert.match(html, /class="deck-quote-mark">“<\/div><blockquote class="deck-quote">q</);
    assert.match(html, /class="deck-columns"/);
    assert.match(html, /Break/);
    assert.strictEqual((html.match(/class="slide cover"/g) || []).length, 2, 'the cover and the closing slide');
});

test('landscape geometry: zero page margin and a page break per slide', () => {
    const html = render();
    assert.match(html, /@page \{ margin: 0; \}/);
    assert.match(html, /page-break-after: always/);
    assert.match(html, /page-break-after: auto/); // the last slide must not add a blank page
});

test('deck visuals in the PDF deck: an inline SVG chart beside the text, KPI tiles, a timeline, and an emphasis slide with its own colours', () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const { resolveDeckTheme } = require('../core/documents/deckThemeOptions');
    const theme = resolveDeckTheme({ enabled: true, accent: '#F5A623', ink: '#1A1A1A', companyName: 'Bee Flow' });
    const deck = normalizeDeck({ title: 'V', slides: [
        { title: 'Omzet', chart: { type: 'column', labels: ['Q1', 'Q2'], series: [{ name: 'Omzet', values: [10, 20] }] }, bullets: ['groei'] },
        { title: 'KPI', stats: [{ value: '€ 1,2M', label: 'Omzet', delta: '+12%' }] },
        { title: 'Plan', steps: [{ title: 'Kick-off', text: 'start' }, { title: 'Live' }] },
        { title: 'Key', style: 'accent', bullets: ['one & two'] },
    ] });
    const html = _test.deckToSlidesHtml(deck, { theme });
    assert.match(html, /<div class="deck-split"><div class="deck-side"><ul><li>groei<\/li><\/ul><\/div><figure class="deck-chart"><svg /);
    assert.match(html, new RegExp(`fill="${theme.chartColors[0]}"`), 'the chart uses the theme palette');
    assert.match(html, /<div class="deck-stats"><div class="deck-stat"><div class="deck-stat-value">€ 1,2M<\/div><div class="deck-stat-label">Omzet<\/div><div class="deck-stat-delta">\+12%<\/div>/);
    assert.match(html, /<ol class="deck-timeline"><li><span class="deck-step-n">1<\/span><div class="deck-step-title">Kick-off<\/div><div class="deck-step-text">start<\/div><\/li>/);
    assert.match(html, /<section class="slide slide-accent" style="--deck-bg:#F5A623;--deck-ink:#1A1D21;/);
    assert.match(html, /one &amp; two/);
    assert.doesNotMatch(html, /<script/);
    assert.match(_test.deckToPlainText(deck), /Chart \(column\):\nOmzet: Q1 = 10, Q2 = 20/);
    assert.match(_test.deckToPlainText(deck), /€ 1,2M Omzet \(\+12%\)/);
    assert.match(_test.deckToPlainText(deck), /1\. Kick-off — start/);
});
