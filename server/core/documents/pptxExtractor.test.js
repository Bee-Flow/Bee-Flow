/**
 * The PPTX reader, round-tripped through our own builder: a deck goes in as
 * officegen bytes and must come back out slide by slide, in order, with the
 * notes and the table it carried. Plus the guards — a zip that is not a
 * deck, a part that claims to be enormous.
 *
 * Run: node --test --test-force-exit core/documents/pptxExtractor.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { extractPptxText, isPptxBuffer, _test } = require('./pptxExtractor');
const { normalizeDeck } = require('./deckModel');
const officegen = require('../../integrations/officegen');

async function build(slides, title = 'Round trip') {
    const deck = normalizeDeck({ title, slides });
    return (await officegen.buildPresentation({ deck })).buffer;
}

test('twelve slides come back numerically ordered — slide 10 after slide 9 — with titles and bullets', async () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ title: `Topic ${i + 1}`, bullets: [`point ${i + 1}`] }));
    const out = await extractPptxText(await build(slides));
    assert.strictEqual(out.slideCount, 13, 'the cover counts as a slide');
    const order = [...out.text.matchAll(/^## Slide (\d+): (.*)$/gm)].map((m) => [Number(m[1]), m[2]]);
    assert.deepStrictEqual(order.map((o) => o[0]), Array.from({ length: 13 }, (_, i) => i + 1));
    assert.strictEqual(order[0][1], 'Round trip');
    assert.strictEqual(order[10][1], 'Topic 10');
    assert.strictEqual(order[11][1], 'Topic 11');
    assert.ok(out.text.indexOf('## Slide 10:') < out.text.indexOf('## Slide 11:'));
    assert.match(out.text, /point 12/);
});

test('speaker notes are labelled under their slide, and a table comes back as rows', async () => {
    const out = await extractPptxText(await build([
        { title: 'With notes', bullets: ['a'], notes: 'Remember to breathe' },
        { title: 'Numbers', table: { columns: ['Regel', '2025'], rows: [['Omzet', 25367]] } },
        { title: 'Quiet' },
    ]));
    assert.strictEqual(out.notesCount, 1);
    assert.match(out.text, /## Slide 2: With notes\na\n\nSpeaker notes:\nRemember to breathe/);
    assert.match(out.text, /\| Regel \| 2025 \|\n\| Omzet \| 25367 \|/);
    assert.match(out.text, /## Slide 4: Quiet/);
    assert.doesNotMatch(out.text, /Remember to breathe[\s\S]*Remember to breathe/, 'notes are not repeated on other slides');
});

test('isPptxBuffer: a deck yes, an arbitrary zip and plain bytes no', async () => {
    assert.strictEqual(await isPptxBuffer(await build([{ title: 'x' }])), true);
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    assert.strictEqual(await isPptxBuffer(await zip.generateAsync({ type: 'nodebuffer' })), false);
    assert.strictEqual(await isPptxBuffer(Buffer.from('not a zip')), false);
});

test('a zip with no slides yields empty text, not an error; the slide cap is honest about what it skipped', async () => {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    const empty = await extractPptxText(await zip.generateAsync({ type: 'nodebuffer' }));
    assert.deepStrictEqual(empty, { text: '', slideCount: 0, notesCount: 0 });

    const capped = await extractPptxText(await build(Array.from({ length: 5 }, (_, i) => ({ title: `s${i}` }))), { maxSlides: 2 });
    assert.strictEqual(capped.slideCount, 6);
    assert.match(capped.text, /4 more slides not read/);
});

test('a part that claims to be huge is refused before it is inflated', async () => {
    const buffer = await build([{ title: 'x' }]);
    await assert.rejects(extractPptxText(buffer, { maxPartBytes: 10 }), (e) => e.errorClass === 'pptx_part_too_large');
});

test('readSlidePart: placeholders for slide number/footer/date are skipped, the title placeholder wins, entities decode', () => {
    const xml = `
<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Body &amp; soul</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>The</a:t></a:r><a:r><a:t> title</a:t></a:r></a:p></p:txBody></p:sp>`;
    const { title, paragraphs } = _test.readSlidePart(xml);
    assert.strictEqual(title, 'The title');
    assert.deepStrictEqual(paragraphs, ['Body & soul']);
    assert.strictEqual(_test.decodeXml('&#233;&#x41;&lt;&amp;'), 'éA<&');
});
