/**
 * A .pptx as a template: its picture layers become the deck's backdrop, its
 * logo an overlay, its text colour the deck's — and a deck built on it
 * carries those pictures in its masters, in both formats.
 *
 * The template under test is BUILT here with pptxgenjs (a full-bleed image,
 * a small logo, white text), so the reader is exercised on real OOXML.
 *
 * Run: node --test --test-force-exit core/documents/pptxTemplate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { extractDeckTemplate, _test } = require('./pptxTemplate');
const opts = require('./deckThemeOptions');

async function png(width, height, background) {
    const sharp = require('sharp');
    const buf = await sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
}

/** A two-slide template: blue full-bleed picture + a small red "logo", white text. */
async function buildTemplate() {
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    const bg = await png(160, 90, { r: 15, g: 150, b: 224, alpha: 1 });
    const logo = await png(40, 40, { r: 220, g: 30, b: 30, alpha: 1 });
    for (const text of ['#Conf26', '']) {
        const s = pptx.addSlide();
        s.addImage({ data: bg, x: 0, y: 0, w: 10, h: 5.625 });
        s.addImage({ data: logo, x: 0.4, y: 0.3, w: 1, h: 1 });
        if (text) s.addText(text, { x: 6, y: 4.8, w: 3.5, h: 0.5, color: 'FFFFFF', fontSize: 14 });
    }
    const out = await pptx.write({ outputType: 'nodebuffer' });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

test('rels and layer geometry are read the OOXML way', () => {
    const rels = _test.parseRels('<Relationships><Relationship Id="rId1" Type="x" Target="../media/image1.png"/><Relationship Id="rId2" Target="/ppt/media/a.png"/></Relationships>', 'ppt/slides');
    assert.deepStrictEqual(rels, { rId1: 'ppt/media/image1.png', rId2: 'ppt/media/a.png' });
    const size = { cx: 12192000, cy: 6858000 };
    const xml = '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="16256000" cy="9144000"/></a:xfrm><a:blipFill><a:blip r:embed="rId1"/></a:blipFill></p:spPr></p:sp>'
        + '<p:pic><p:spPr><a:xfrm><a:off x="609600" y="609600"/><a:ext cx="1219200" cy="1219200"/></a:xfrm></p:spPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
        + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:sp>';
    const layers = _test.collectLayers(xml, rels, size);
    assert.strictEqual(layers.length, 2, 'the placeholder shape is not a layer');
    assert.strictEqual(layers[0].full, true, 'a picture larger than the slide is a full-bleed layer');
    assert.strictEqual(layers[1].full, false);
    assert.ok(Math.abs(layers[1].x - 0.05) < 1e-6 && Math.abs(layers[1].w - 0.1) < 1e-6);
});

test('a template deck yields composited backdrops, the logo as an overlay, the mean colour and the text colour', async () => {
    const tpl = await extractDeckTemplate(await buildTemplate(), { name: 'Conf 2026.pptx' });
    assert.strictEqual(tpl.name, 'Conf 2026');
    assert.match(tpl.cover.image, /^data:image\/jpeg;base64,/);
    assert.match(tpl.content.image, /^data:image\/jpeg;base64,/);
    assert.strictEqual(tpl.cover.overlays.length, 1, 'the small picture is an overlay, not part of the backdrop');
    const o = tpl.cover.overlays[0];
    assert.ok(Math.abs(o.x - 0.04) < 0.01 && Math.abs(o.w - 0.1) < 0.01, `overlay box ${JSON.stringify(o)}`);
    assert.match(o.image, /^data:image\/png;base64,/);
    // Mean colour ≈ the blue (the tiny logo barely moves it)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(tpl.background.slice(i, i + 2), 16));
    assert.ok(r < 40 && g > 120 && b > 200, `mean colour is the blue: ${tpl.background}`);
    assert.strictEqual(tpl.text, '#FFFFFF', 'the template writes in white');
    assert.ok(Math.abs(tpl.aspect - 16 / 9) < 0.01);
});

test('the theme built on a template: white text on the blue, no band, the template logo instead of the letterhead one, an on-colour chart palette', async () => {
    const tpl = await extractDeckTemplate(await buildTemplate());
    const org = { enabled: true, accent: '#F5A623', ink: '#1A1A1A', companyName: 'Bee Flow', logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=', logoWidthMm: 24 };
    const t = opts.resolveDeckTheme(org, null, opts.normaliseDeckOverrides({ template: tpl }));
    assert.strictEqual(t.text, '#FFFFFF', 'the template\'s own text colour, which reads at slide sizes');
    assert.strictEqual(t.titleStyle, 'plain');
    assert.strictEqual(t.bandColor, null);
    assert.strictEqual(t.logoPlacement, 'none', 'the template brings its own logo');
    assert.strictEqual(t.brandOnSlides, false);
    assert.ok(t.template && t.template.cover.image && t.template.content.overlays.length === 1);
    assert.strictEqual(t.glass, true);
    assert.strictEqual(t.chartColors[0], '#FFFFFF', 'on a mid-tone surface the palette starts from the text colour');
    for (const c of t.chartColors) assert.ok(opts.contrastRatio(c, t.background) >= 1.5, `${c} shows on ${t.background}`);
    // Stored in the house style it normalises to the same object; 'none' switches it off per deck.
    const stored = opts.normaliseDeckStyle({ template: tpl });
    assert.ok(stored.template && stored.template.cover.image === tpl.cover.image);
    const off = opts.resolveDeckTheme(org, stored, opts.normaliseDeckOverrides({ template: 'none' }));
    assert.strictEqual(off.template, null);
    assert.strictEqual(off.titleStyle, 'band');
    assert.strictEqual(opts.normaliseTemplate({ cover: { image: 'https://x/y.png' } }), null, 'only inline pictures');
    assert.strictEqual(opts.normaliseTemplate('x'), null);
});

test('a deck built on a template carries its pictures in the masters and the logo overlay on every slide, in .pptx and PDF', async () => {
    const tpl = await extractDeckTemplate(await buildTemplate());
    const { normalizeDeck } = require('./deckModel');
    const officegen = require('../../integrations/officegen');
    const theme = opts.resolveDeckTheme({ enabled: true, accent: '#F5A623', ink: '#1A1A1A' }, null, { template: tpl });
    const deck = normalizeDeck({ title: 'On brand', slides: [
        { title: 'KPI', stats: [{ value: '1', label: 'a' }] },
        { title: 'Chart', chart: { labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] } },
        { title: 'Key', style: 'accent', bullets: ['x'] },
    ] });
    const out = await officegen.buildPresentation({ deck, theme });
    const zip = await JSZip.loadAsync(out.buffer);
    let coverLayout = null; let contentLayout = null; let accentLayout = null;
    for (const n of Object.keys(zip.files).filter((f) => /slideLayouts\/slideLayout\d+\.xml$/.test(f))) {
        const x = await zip.file(n).async('string');
        if (x.includes('name="BF_COVER"')) coverLayout = x;
        if (x.includes('name="BF_CONTENT"')) contentLayout = x;
        if (x.includes('name="BF_CONTENT_ACCENT"')) accentLayout = x;
    }
    assert.match(coverLayout, /<p:bg>[\s\S]*?<a:blipFill/, 'the cover master is the template picture');
    assert.match(contentLayout, /<p:bg>[\s\S]*?<a:blipFill/);
    assert.match(contentLayout, /<p:pic>/, 'the logo overlay sits on the master');
    assert.strictEqual(accentLayout, null, 'emphasis styles do not repaint a template');
    const kpi = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.match(kpi, /<a:alpha val="16000"\/>/, 'a card on a picture is frosted');
    const chart = await zip.file('ppt/charts/chart1.xml').async('string');
    assert.match(chart, /<c:spPr><a:noFill\/>/, 'the chart has no plate of its own');
    assert.match(chart, /srgbClr val="FFFFFF"/, 'the first series is drawn in the text colour');
    const { _test: dr } = require('../../services/documentRenderer');
    const html = dr.deckToSlidesHtml(deck, { theme });
    assert.match(html, /\.slide, \.cover \{ background-image: url\("data:image\/jpeg/);
    assert.strictEqual((html.match(/class="deck-overlay"/g) || []).length, 4, 'cover + three slides carry the overlay');
    assert.match(html, /color-mix\(in srgb, var\(--deck-ink\) 16%, transparent\)/);
});

test('refusals: not a deck, a deck without pictures, too large', async () => {
    await assert.rejects(extractDeckTemplate(Buffer.from('PKnope')), /not a PowerPoint deck|Corrupted|End of data|invalid/i);
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('plain', { x: 1, y: 1, w: 3, h: 1 });
    const plain = await pptx.write({ outputType: 'nodebuffer' });
    await assert.rejects(extractDeckTemplate(Buffer.isBuffer(plain) ? plain : Buffer.from(plain)), (e) => e.errorClass === 'template_no_layers');
    await assert.rejects(extractDeckTemplate(Buffer.alloc(26 * 1024 * 1024)), (e) => e.errorClass === 'template_too_large');
});
