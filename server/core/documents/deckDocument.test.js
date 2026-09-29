/**
 * A presentation as a Studio Document: the outline in the body slot, filled
 * as TEXT, rendered through the deck engine into the viewer, the .pptx and
 * the PDF — and kept in the library from a deck the chat built.
 *
 * DB-free: the document store is stubbed where the library is written to,
 * config/storage are never reached (no org → the neutral theme), and the
 * browser is absent so the PDF path takes its pdfkit fallback.
 *
 * Run: node --test --test-force-exit core/documents/deckDocument.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const created = [];
installResolveStub({
    '../../stores/documentStore': {
        createDocument: async (input) => { created.push(input); return { id: `doc-${created.length}`, name: input.name, versionId: 'v1' }; },
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    './browserProvider': { withContext: async () => { throw new Error('no browser in this test'); } },
});

const dd = require('./deckDocument');
const { renderFilledDocument, documentFileName } = require('./renderFilledDocument');
const { normalizeDeck, deckToMarkdown } = require('./deckModel');
const { deckStarters } = require('./documentStarters');

const OUTLINE = '# Hello {{customer.name}}\n\nA subtitle\n\n## One\n- a\n- b\n\n## KPIs\n```stats\n12 | Klanten | +3 | users\n```\n\n## Close\n<!-- layout: closing -->\n{{customer.name}} · {{date}}\n';
const deckDoc = (over = {}) => ({ id: 'd1', name: 'Demo deck', docType: 'presentation', bodyHtml: OUTLINE, css: '', settings: { deck: { preset: 'dark', accent: '#0489D2' } }, versionId: 'v1', ...over });

test('isDeckDocument is the docType, and the outline fills as TEXT — an ampersand is not escaped', () => {
    assert.strictEqual(dd.isDeckDocument(deckDoc()), true);
    assert.strictEqual(dd.isDeckDocument({ docType: 'invoice' }), false);
    const { deck, fill } = dd.deckFromDocument(deckDoc(), { customer: { name: 'Bee & Co' }, date: '2026-09-18' });
    assert.strictEqual(deck.title, 'Hello Bee & Co');
    assert.strictEqual(deck.subtitle, 'A subtitle');
    assert.deepStrictEqual(deck.slides.map((s) => s.layout), ['bullets', 'stats', 'closing']);
    assert.deepStrictEqual(fill.missing, []);
    assert.strictEqual(fill.valid, true);
});

test('without values the outline renders as written (tokens kept); no outline title = the document name; empty = document_empty', () => {
    const { deck, fill } = dd.deckFromDocument(deckDoc());
    assert.strictEqual(fill, null);
    assert.strictEqual(deck.title, 'Hello {{customer.name}}');
    const named = dd.deckFromDocument(deckDoc({ bodyHtml: '## Only a slide\n- x' })).deck;
    assert.strictEqual(named.title, 'Demo deck');
    assert.throws(() => dd.deckFromDocument(deckDoc({ bodyHtml: '  ' })), (e) => e.errorClass === 'document_empty');
    assert.throws(() => dd.deckFromDocument({ docType: 'letter', bodyHtml: '<p>x</p>' }), (e) => e.errorClass === 'document_not_deck');
});

test('the deck overrides are what the document set — validated, empties dropped', () => {
    assert.deepStrictEqual(dd.deckOverridesOf(deckDoc()), { preset: 'dark', accent: '#0489D2' });
    assert.deepStrictEqual(dd.deckOverridesOf(deckDoc({ settings: { deck: { preset: 'nope', accent: '', logo: 'none', footerText: 'Q3' } } })), { logo: 'none', footerText: 'Q3' });
    assert.deepStrictEqual(dd.deckOverridesOf({ docType: 'presentation' }), {});
});

test('format html is the on-screen viewer: one framed card per slide, the footer line and slide numbers inside each, the ready message; the look comes from settings.deck', async () => {
    const out = await dd.renderDeckDocument({ document: deckDoc({ settings: { deck: { footerText: 'Bee Flow · 2026' } } }), format: 'html', values: { customer: { name: 'ACME' }, date: '2026-09-18' } });
    assert.strictEqual(out.format, 'html');
    assert.strictEqual(out.slideCount, 4);
    assert.strictEqual((out.html.match(/class="deck-frame"/g) || []).length, 4, 'cover + three slides');
    assert.match(out.html, /Hello ACME/);
    assert.strictEqual((out.html.match(/class="deck-footer"/g) || []).length, 4, 'the footer line sits on every slide, not once on the viewport');
    assert.match(out.html, /class="deck-number">2</);
    assert.doesNotMatch(out.html, /class="deck-number">1</, 'the cover carries no number');
    assert.match(out.html, /__beeflowDeckReady/);
    assert.match(out.html, /position: fixed/, 'the print rules are still there…');
    assert.match(out.html, /\.deck-footer, \.deck-logo, \.ai-mark \{ position: absolute; \}/, '…and overridden for the screen');
    assert.ok(out.fill && out.fill.valid);
});

test('a draft previews unsaved edits without touching the document: another outline, another look', async () => {
    const doc = deckDoc();
    const out = await dd.renderDeckDocument({ document: doc, format: 'html', draft: { bodyHtml: '# Draft title\n\n## Only\n- z', settings: { deck: { preset: 'band' } } } });
    assert.match(out.html, /Draft title/);
    assert.doesNotMatch(out.html, /Hello/);
    assert.strictEqual(out.slideCount, 2);
    assert.strictEqual(doc.bodyHtml, OUTLINE, 'the document itself is untouched');
});

test('renderFilledDocument hands a presentation to the deck engine: .pptx by default, the PDF deck on request, same fill report', async () => {
    const values = { customer: { name: 'ACME' }, date: '2026-09-18' };
    const pptx = await renderFilledDocument({ document: deckDoc(), values });
    assert.strictEqual(pptx.format, 'pptx');
    assert.strictEqual(pptx.extension, 'pptx');
    assert.strictEqual(pptx.contentType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.ok(Buffer.isBuffer(pptx.buffer) && pptx.buffer.length > 5000);
    assert.strictEqual(pptx.slideCount, 4);
    assert.deepStrictEqual(pptx.fill.missing, []);
    const pdf = await renderFilledDocument({ document: deckDoc(), values, format: 'pdf' });
    assert.strictEqual(pdf.extension, 'pdf');
    assert.strictEqual(pdf.contentType, 'application/pdf');
    assert.strictEqual(pdf.degraded, true, 'no browser here → the pdfkit fallback, and it says so');
    // A required value that is missing is refused the way a page is.
    const strict = deckDoc({ settings: { contract: { parameters: [{ key: 'customer.name', type: 'text', required: true }] } } });
    await assert.rejects(renderFilledDocument({ document: strict, values: {} }), (e) => e.errorClass === 'document_validation_failed');
    assert.strictEqual(documentFileName('Q3 review', 'document', 'pptx'), 'Q3 review.pptx');
    assert.strictEqual(documentFileName('deck.pptx', 'document', 'pptx'), 'deck.pptx');
    assert.strictEqual(documentFileName('', 'document'), 'document.pdf');
});

test('keepDeckInLibrary writes the outline of a normalised deck as a presentation document, with its look; a store failure yields null', async () => {
    created.length = 0;
    const deck = normalizeDeck({ title: 'Kwartaal', slides: [{ title: 'Omzet', bullets: ['12%'], notes: 'zeg dit' }, { title: 'Cards', cards: [{ title: 'A', text: 'a', icon: 'shield' }, { title: 'B', text: 'b' }, { title: 'C', text: 'c' }] }] });
    const kept = await dd.keepDeckInLibrary({ userId: 'u1', deck, theme: { preset: 'bold', logo: 'none' }, houseStyle: true, source: 'create_presentation' });
    assert.deepStrictEqual(kept, { documentId: 'doc-1', url: '/app/studio/documents/doc-1', name: 'Kwartaal' });
    const input = created[0];
    assert.strictEqual(input.docType, 'presentation');
    assert.strictEqual(input.kind, 'document');
    assert.strictEqual(input.css, '');
    assert.deepStrictEqual(input.settings.deck, { preset: 'bold', logo: 'none' });
    assert.strictEqual(input.settings.houseStyle, undefined, 'only an opt-out is recorded');
    assert.strictEqual(input.settings.generatedFrom.source, 'create_presentation');
    // The outline round-trips to the same slides.
    const again = normalizeDeck(input.bodyHtml);
    assert.deepStrictEqual(again.slides.map((s) => [s.layout, s.title, s.notes]), [['bullets', 'Omzet', 'zeg dit'], ['cards', 'Cards', null]]);
    assert.strictEqual(again.slides[1].cards[0].icon, 'shield');
    assert.strictEqual(input.bodyHtml, deckToMarkdown(deck));
    const off = await dd.keepDeckInLibrary({ userId: 'u1', deck, houseStyle: false });
    assert.strictEqual(created[1].settings.houseStyle, false);
    assert.ok(off);
    assert.strictEqual(await dd.keepDeckInLibrary({ userId: '', deck }), null);
});

test('the presentation starters are outlines that parse and carry their placeholders', () => {
    const { getContract } = require('./documentContract');
    for (const locale of ['en', 'nl']) {
        const list = deckStarters(locale);
        assert.strictEqual(list.length, 3);
        for (const st of list) {
            assert.strictEqual(st.docType, 'presentation');
            assert.strictEqual(st.kind, 'template');
            const deck = normalizeDeck({ markdown: st.bodyHtml });
            assert.ok(deck.slides.length >= 4, `${st.id} has slides`);
            assert.deepStrictEqual(deck.warnings, []);
            const contract = getContract({ ...st, id: st.id, versionId: 'v' });
            assert.ok(contract.parameters.some((p) => p.key === 'customer.name'));
            assert.ok(contract.placeholders.some((p) => p.key === 'title'));
        }
    }
});
