/**
 * Unit tests for officegen — the binary office-file generators behind the
 * Nextcloud "create real spreadsheet / document" tools. Each generated file is
 * re-opened as a ZIP and its inner XML inspected, so a malformed package fails
 * loudly here rather than in Nextcloud Office.
 *
 * Run: node --test integrations/officegen.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const JSZip = require('jszip');
const office = require('./officegen');

const ROWS = [
    { Invoice: '202600117', Vendor: 'Van Dijk Kantoor B.V.', Amount: 47.87, Status: 'unpaid' },
    { Invoice: '202600342', Vendor: 'De Vries Brandstof B.V.', Amount: 9.08, Status: 'paid' },
];

test('rowsToMatrix — objects → header + rows in first-seen key order', () => {
    const m = office.rowsToMatrix(ROWS);
    assert.deepStrictEqual(m[0], ['Invoice', 'Vendor', 'Amount', 'Status']);
    assert.deepStrictEqual(m[1], ['202600117', 'Van Dijk Kantoor B.V.', 47.87, 'unpaid']);
    assert.strictEqual(typeof m[1][2], 'number', 'numbers stay numeric');
});

test('rowsToMatrix — explicit columns control order + missing cells blank', () => {
    const m = office.rowsToMatrix(ROWS, ['Vendor', 'Missing', 'Amount']);
    assert.deepStrictEqual(m[0], ['Vendor', 'Missing', 'Amount']);
    assert.strictEqual(m[1][1], '', 'unknown column → empty cell');
});

test('rowsToMatrix — array-of-arrays passes through with optional header', () => {
    const m = office.rowsToMatrix([[1, 2], [3, 4]], ['A', 'B']);
    assert.deepStrictEqual(m, [['A', 'B'], [1, 2], [3, 4]]);
});

test('resolveOfficeFormat + ensureExt', () => {
    assert.strictEqual(office.resolveOfficeFormat(null, '/a/b.ods', ['xlsx', 'ods'], 'xlsx'), 'ods');
    assert.strictEqual(office.resolveOfficeFormat('xlsx', '/a/b.ods', ['xlsx', 'ods'], 'xlsx'), 'xlsx');
    assert.strictEqual(office.resolveOfficeFormat(null, '/a/b', ['xlsx', 'ods'], 'xlsx'), 'xlsx');
    assert.strictEqual(office.ensureExt('/Reports/x', 'xlsx'), '/Reports/x.xlsx');
    assert.strictEqual(office.ensureExt('/Reports/x.xlsx', 'xlsx'), '/Reports/x.xlsx');
    assert.strictEqual(office.ensureExt('/Reports/x.csv', 'xlsx'), '/Reports/x.csv.xlsx');
});

test('colLetter spreadsheet column references', () => {
    const { colLetter } = office._internal;
    assert.strictEqual(colLetter(0), 'A');
    assert.strictEqual(colLetter(25), 'Z');
    assert.strictEqual(colLetter(26), 'AA');
});

test('buildSpreadsheet xlsx — valid OOXML package with our data', async () => {
    const { buffer, contentType, format } = await office.buildSpreadsheet({ matrix: office.rowsToMatrix(ROWS), sheetName: 'Invoices', format: 'xlsx' });
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
    assert.strictEqual(format, 'xlsx');
    assert.strictEqual(contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const zip = await JSZip.loadAsync(buffer);
    assert.ok(zip.file('[Content_Types].xml'), 'has content types');
    assert.ok(zip.file('xl/workbook.xml'), 'has workbook');
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.ok(sheet.includes('Van Dijk Kantoor B.V.'), 'string cell present');
    assert.ok(sheet.includes('<v>47.87</v>'), 'numeric cell present as a number');
    const wb = await zip.file('xl/workbook.xml').async('string');
    assert.ok(wb.includes('name="Invoices"'), 'sheet name applied');
});

test('buildSpreadsheet ods — ODF package, mimetype entry present + correct', async () => {
    const { buffer, contentType } = await office.buildSpreadsheet({ matrix: office.rowsToMatrix(ROWS), format: 'ods' });
    assert.strictEqual(contentType, 'application/vnd.oasis.opendocument.spreadsheet');
    const zip = await JSZip.loadAsync(buffer);
    const mt = await zip.file('mimetype').async('string');
    assert.strictEqual(mt, 'application/vnd.oasis.opendocument.spreadsheet');
    const content = await zip.file('content.xml').async('string');
    assert.ok(content.includes('office:value-type="float" office:value="47.87"'), 'numeric ODF cell');
    assert.ok(content.includes('De Vries Brandstof B.V.'), 'string ODF cell');
});

test('xlsx escapes XML-special characters', async () => {
    const { buffer } = await office.buildSpreadsheet({ matrix: [['a<b>&"c']], format: 'xlsx' });
    const zip = await JSZip.loadAsync(buffer);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.ok(sheet.includes('a&lt;b&gt;&amp;&quot;c'), 'special chars escaped');
});

test('buildDocument docx — valid OOXML doc with headings + body', async () => {
    const { buffer, contentType, format } = await office.buildDocument({ content: '# Title\n\nHello world\n\n- one\n- two', title: 'Invoice summary', format: 'docx' });
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
    assert.strictEqual(format, 'docx');
    assert.strictEqual(contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const zip = await JSZip.loadAsync(buffer);
    const doc = await zip.file('word/document.xml').async('string');
    assert.ok(doc.includes('Hello world'), 'body text present');
    assert.ok(doc.includes('Invoice summary'), 'title present');
});

test('buildDocument odt — ODF text with headings + paragraphs', async () => {
    const { buffer, contentType } = await office.buildDocument({ content: '# Heading\n\nA paragraph.', format: 'odt' });
    assert.strictEqual(contentType, 'application/vnd.oasis.opendocument.text');
    const zip = await JSZip.loadAsync(buffer);
    const mt = await zip.file('mimetype').async('string');
    assert.strictEqual(mt, 'application/vnd.oasis.opendocument.text');
    const content = await zip.file('content.xml').async('string');
    assert.ok(content.includes('<text:h text:outline-level="1">Heading</text:h>'), 'heading rendered');
    assert.ok(content.includes('<text:p>A paragraph.</text:p>'), 'paragraph rendered');
});

test('parseBlocks strips light markdown emphasis', () => {
    const { parseBlocks } = office._internal;
    const blocks = parseBlocks('**bold** and `code`');
    assert.strictEqual(blocks[0].text, 'bold and code');
});

// ── buildPresentation (.pptx via pptxgenjs) ─────────────────────────────

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sampleDeck() {
    const { normalizeDeck } = require('../core/documents/deckModel');
    return normalizeDeck({ title: 'Demo deck', subtitle: 'Voor de bank', slides: [
        { title: 'Omzet', bullets: ['Groei 12%', '  vooral DE', 'Marge stabiel'], notes: 'Benadruk DE' },
        { title: 'Cijfers', table: { columns: ['Regel', '2025'], rows: [['Omzet', 25367], ['EBITDA', 1200]] } },
        { title: 'Quote', quote: { text: 'Wij groeien door.', attribution: 'CEO' } },
        { title: 'Kolommen', columns: [{ title: 'Links', bullets: ['a', 'b'] }, { title: 'Rechts', bullets: ['c'] }] },
        { title: 'Plaatje', image: { dataUrl: PNG_1x1, alt: 'x' }, bullets: ['met tekst'] },
        { title: 'Hoofdstuk 2', layout: 'section' },
        { title: 'Bedankt', layout: 'closing', body: 'info@example.test' },
    ] });
}

const THEME = { accent: '#A03B3B', ink: '#222', muted: '#6b6b6b', fontFace: 'Cambria', brandName: 'R & R', footerText: 'Vertrouwelijk', logoDataUrl: PNG_1x1, logoWidthIn: 0.8 };

/** The layout XML of a named master — pptxgenjs numbers layouts by definition order, names are stable. */
async function layoutNamed(zip, name) {
    for (const n of Object.keys(zip.files).filter((f) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))) {
        const xml = await zip.file(n).async('string');
        if (xml.includes(`<p:cSld name="${name}">`)) return xml;
    }
    throw new Error(`no layout named ${name}`);
}

test('buildPresentation — a valid PPTX package with one slide per deck slide plus the cover', async () => {
    const out = await office.buildPresentation({ deck: sampleDeck(), theme: THEME });
    assert.strictEqual(out.contentType, office.CONTENT_TYPES.pptx);
    assert.strictEqual(out.format, 'pptx');
    assert.strictEqual(out.slideCount, 8);
    assert.ok(Buffer.isBuffer(out.buffer) && out.buffer.length > 1000);

    const zip = await JSZip.loadAsync(out.buffer);
    const ct = await zip.file('[Content_Types].xml').async('string');
    assert.match(ct, /presentationml\.presentation\.main\+xml/);
    for (let i = 1; i <= 8; i += 1) assert.ok(zip.file(`ppt/slides/slide${i}.xml`), `slide${i}.xml`);
    assert.ok(!zip.file('ppt/slides/slide9.xml'));
});

test('buildPresentation — text, notes, table, image and the theme land where PowerPoint reads them', async () => {
    const out = await office.buildPresentation({ deck: sampleDeck(), theme: THEME });
    const zip = await JSZip.loadAsync(out.buffer);
    const s2 = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.match(s2, /Groei 12%/);
    assert.match(s2, /Omzet/);
    const notes2 = await zip.file('ppt/notesSlides/notesSlide2.xml').async('string');
    assert.match(notes2, /Benadruk DE/);
    const s3 = await zip.file('ppt/slides/slide3.xml').async('string');
    assert.match(s3, /<a:tbl>/);
    assert.match(s3, /25367/);
    const s6 = await zip.file('ppt/slides/slide6.xml').async('string');
    assert.match(s6, /<p:pic>/);
    assert.ok(Object.keys(zip.files).some((n) => /^ppt\/media\/.*\.png$/.test(n)), 'image bytes stored as media');
    // The theme lives in the content layout: band colour, brand mark, footer text.
    const layout = await layoutNamed(zip, 'BF_CONTENT');
    assert.match(layout, /A03B3B/);
    assert.match(layout, /R &amp; R/);
    assert.match(layout, /Vertrouwelijk/);
    const theme = await zip.file('ppt/theme/theme1.xml').async('string');
    assert.match(theme, /typeface="Cambria"/);
    const core = await zip.file('docProps/core.xml').async('string');
    assert.match(core, /<dc:title>Demo deck<\/dc:title>/);
    assert.doesNotMatch(core, /cp:keywords/, 'no marking → no keywords');
});

test('buildPresentation — the Art. 50(2) marking is in the core properties and on every content slide', async () => {
    const marking = {
        subject: 'AI-generated content — EU AI Act Art. 50(2)', creator: 'Org',
        keywords: ['AIGenerated=true', 'AIProvider=claude'], description: 'Generated with AI — Org', footerLine: 'Generated with AI — Org',
    };
    const out = await office.buildPresentation({ deck: sampleDeck(), theme: THEME, marking });
    const zip = await JSZip.loadAsync(out.buffer);
    const core = await zip.file('docProps/core.xml').async('string');
    assert.match(core, /<dc:subject>AI-generated content — EU AI Act Art\. 50\(2\)<\/dc:subject>/);
    assert.match(core, /<dc:creator>Org<\/dc:creator>/);
    assert.match(core, /<cp:keywords>AIGenerated=true; AIProvider=claude<\/cp:keywords>/);
    assert.match(core, /<dc:description>Generated with AI — Org<\/dc:description>/);
    const layout = await layoutNamed(zip, 'BF_CONTENT');
    assert.match(layout, /Vertrouwelijk\s+·\s+Generated with AI — Org/);
});

test('buildPresentation — stampPptxCoreProperties is idempotent', async () => {
    const out = await office.buildPresentation({ deck: sampleDeck() });
    const once = await office._internal.stampPptxCoreProperties(out.buffer, { keywords: ['a=1'], description: 'd' });
    const twice = await office._internal.stampPptxCoreProperties(once, { keywords: ['a=2'], description: 'e' });
    const core = await (await JSZip.loadAsync(twice)).file('docProps/core.xml').async('string');
    assert.strictEqual((core.match(/<cp:keywords>/g) || []).length, 1);
    assert.match(core, /<cp:keywords>a=2<\/cp:keywords><dc:description>e<\/dc:description>/);
});

test('buildPresentation — refuses anything but PNG/JPEG data: images (pptxgenjs would fetch a path)', async () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    const deck = normalizeDeck({ title: 'T', slides: [{ title: 'i', image: { dataUrl: svg } }] });
    await assert.rejects(office.buildPresentation({ deck }), (e) => e.errorClass === 'deck_image_unsupported');
    // A logo in the wrong format is simply not placed — the deck still builds.
    const out = await office.buildPresentation({ deck: sampleDeck(), theme: { logoDataUrl: svg } });
    assert.ok(out.buffer.length > 0);
});

test('buildPresentation — the neutral theme when none is given, colours normalised for pptxgenjs', async () => {
    const t = office._internal.deckTheme({ accent: '#abc', ink: 'not-a-colour' });
    assert.strictEqual(t.accent, 'AABBCC');
    assert.strictEqual(t.text, '1A1D21', 'an unreadable ink is replaced by a readable one');
    assert.strictEqual(t.titleStyle, 'band', 'a bare palette resolves to the default preset');
    assert.strictEqual(office._internal.pptxHex('#123a5e', 'X'), '123A5E');
    assert.strictEqual(office._internal.footerLineFor({ footerText: '', brandName: 'Bee' }, null), 'Bee');
    const out = await office.buildPresentation({ deck: sampleDeck() });
    const layout = await layoutNamed(await JSZip.loadAsync(out.buffer), 'BF_CONTENT');
    assert.match(layout, /123A5E/);
});

// ── visuals & emphasis slides (round 3) ─────────────────────────────────

test('buildPresentation — charts are NATIVE chart parts in the theme palette; tiles and timelines are shapes; accent/dark slides get their own master', async () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const { resolveDeckTheme } = require('../core/documents/deckThemeOptions');
    const deck = normalizeDeck({ title: 'Visuals', slides: [
        { title: 'Omzet', chart: { type: 'column', labels: ['Q1', 'Q2'], series: [{ name: 'Omzet', values: [10, 20] }, { name: 'Kosten', values: [5, 8] }] }, bullets: ['groei'] },
        { title: 'Regio', chart: { type: 'donut', labels: ['N', 'Z'], series: [{ name: 'x', values: [1, 3] }] } },
        { title: 'KPI', stats: [{ value: '€ 1,2M', label: 'Omzet', delta: '+12%' }, { value: '48', label: 'Klanten' }] },
        { title: 'Plan', steps: [{ title: 'Kick-off', text: 'start' }, { title: 'Live' }] },
        { title: 'Key message', style: 'accent', bullets: ['one thing'] },
        { title: 'Dark', style: 'dark', table: { columns: ['a', 'b'], rows: [['x', 1]] } },
    ] });
    const theme = resolveDeckTheme({ enabled: true, accent: '#F5A623', ink: '#1A1A1A', companyName: 'Bee Flow' });
    const out = await office.buildPresentation({ deck, theme });
    const zip = await JSZip.loadAsync(out.buffer);
    const charts = Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f));
    assert.strictEqual(charts.length, 2, 'two chart parts');
    const bar = await zip.file(charts[0]).async('string');
    assert.match(bar, /<c:barChart>/);
    assert.match(bar, /<c:v>Omzet<\/c:v>/);
    assert.match(bar, /<c:v>Kosten<\/c:v>/);
    assert.match(bar, new RegExp(`srgbClr val="${theme.chartColors[1].slice(1)}"`), 'series 2 painted in the second palette colour');
    const donut = await zip.file(charts[1]).async('string');
    assert.match(donut, /<c:doughnutChart>/);
    assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /<c:chart /, 'the chart sits on the Omzet slide');
    const kpi = await zip.file('ppt/slides/slide4.xml').async('string');
    assert.match(kpi, /prst="roundRect"/);
    assert.match(kpi, /€ 1,2M/);
    assert.match(kpi, /\+12%/);
    const plan = await zip.file('ppt/slides/slide5.xml').async('string');
    assert.ok((plan.match(/prst="ellipse"/g) || []).length === 4, 'one node (and its surface ring) per step');
    assert.match(plan, /prst="line"/);
    assert.match(plan, /Kick-off/);
    // Emphasis slides: their own masters, defined lazily, on their own surface.
    const accentLayout = await layoutNamed(zip, 'BF_CONTENT_ACCENT');
    assert.match(accentLayout, /<a:srgbClr val="F5A623"\/>/);
    const darkLayout = await layoutNamed(zip, 'BF_CONTENT_DARK');
    assert.match(darkLayout, /<a:srgbClr val="16191F"\/>/);
    const dark = await zip.file('ppt/slides/slide7.xml').async('string');
    assert.match(dark, /<a:tbl>/);
    assert.match(dark, /srgbClr val="F3F4F6"/, 'body text is light on the dark slide');
    assert.match(dark, /srgbClr val="1A1D21"/, 'the table header text is dark on its orange fill — by contrast, not by preset');
    // A deck without emphasis slides defines no extra masters.
    const plain = await office.buildPresentation({ deck: sampleDeck(), theme });
    await assert.rejects(layoutNamed(await JSZip.loadAsync(plain.buffer), 'BF_CONTENT_ACCENT'));
});

test('buildPresentation — logo and image boxes follow the measured aspect ratio; no srcRect trick Collabora would ignore', async () => {
    const { fitBox } = office._internal;
    assert.deepStrictEqual(fitBox(2, 0, 0, 1, 1), { x: 0, y: 0.25, w: 1, h: 0.5 });
    assert.deepStrictEqual(fitBox(0.5, 0, 0, 1, 1, { align: 'center', valign: 'top' }), { x: 0.25, y: 0, w: 0.5, h: 1 });
    const deck = sampleDeck();
    deck.slides[4].image.aspect = 1; // the 1×1 png
    const out = await office.buildPresentation({ deck, theme: { ...THEME, logoAspect: 1 } });
    const zip = await JSZip.loadAsync(out.buffer);
    for (const n of Object.keys(zip.files).filter((f) => /^ppt\/(slides|slideLayouts)\/.*\.xml$/.test(f))) {
        assert.doesNotMatch(await zip.file(n).async('string'), /<a:srcRect/, `${n} has no crop`);
    }
    const layout = await layoutNamed(zip, 'BF_CONTENT');
    const ext = /<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(layout);
    assert.ok(ext && ext[1] === ext[2], `a square logo gets a square box, got ${ext && ext.slice(1)}`);
    const pic = /<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(await zip.file('ppt/slides/slide6.xml').async('string'));
    assert.ok(pic && pic[1] === pic[2], 'a square slide image gets a square box');
});

test('buildPresentation — cards are soft roundRects in a row, or a 2×2 grid for four with a lead', async () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const deck = normalizeDeck({ title: 'C', slides: [
        { title: 'Three', cards: [{ title: 'A', text: 'a' }, { title: 'B', text: 'b' }, { title: 'C', text: 'c' }] },
        { title: 'Four', body: 'Lead', cards: [{ title: 'A', text: 'a' }, { title: 'B', text: 'b' }, { title: 'C', text: 'c' }, { title: 'D', text: 'd' }] },
    ] });
    const out = await office.buildPresentation({ deck });
    const zip = await JSZip.loadAsync(out.buffer);
    const three = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.strictEqual((three.match(/prst="roundRect"/g) || []).length, 3);
    assert.match(three, />A</);
    const four = await zip.file('ppt/slides/slide3.xml').async('string');
    assert.strictEqual((four.match(/prst="roundRect"/g) || []).length, 4);
    assert.match(four, /Lead/);
});

test('buildPresentation — a card with an icon carries the bitmap, a tile too; six cards make a 3×2 grid', async () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const { _test: rt } = require('../services/presentationRenderer');
    const deck = normalizeDeck({ title: 'I', slides: [
        { title: 'Why', cards: [{ title: 'A', text: 'a', icon: 'wifi-off' }, { title: 'B', text: 'b', icon: 'shield' }, { title: 'C', text: 'c' }] },
        { title: 'KPI', stats: [{ value: '2m', label: 'Time', icon: 'clock' }] },
        { title: 'Six', cards: [1, 2, 3, 4, 5, 6].map((i) => ({ title: `C${i}`, text: 'x' })) },
    ] });
    await rt.resolveDeckImages(deck, null, [], { accentOnSlide: '#123A5E' });
    assert.ok(deck.slides[0].cards[0].iconDataUrl && deck.slides[1].stats[0].iconDataUrl);
    const out = await office.buildPresentation({ deck });
    const zip = await JSZip.loadAsync(out.buffer);
    const why = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.strictEqual((why.match(/<p:pic>/g) || []).length, 2, 'two icon bitmaps, the third card keeps its accent bar');
    const kpi = await zip.file('ppt/slides/slide3.xml').async('string');
    assert.strictEqual((kpi.match(/<p:pic>/g) || []).length, 1);
    const six = await zip.file('ppt/slides/slide4.xml').async('string');
    assert.strictEqual((six.match(/prst="roundRect"/g) || []).length, 6);
});
