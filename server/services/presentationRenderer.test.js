/**
 * renderPresentation is the one function every presentation surface calls,
 * so this pins its contract: theme resolution and the opt-out, image
 * resolution through the injected resolver (never a fetch), the marking
 * report, and the two formats.
 *
 * DB-free: configStore is stubbed (the real one fires initDB() at require
 * time) and so is the browser, so the PDF path takes the pdfkit fallback.
 *
 * Run: node --test --test-force-exit services/presentationRenderer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { installResolveStub } = require('../testUtils/stubRequire');

const styles = new Map();
installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => styles.get(key) ?? null,
        setConfig: async (key, value) => { styles.set(key, value); },
    },
    './browserProvider': {
        withContext: async () => { throw new Error('no browser in this test'); },
    },
});

const { renderPresentation, toPptxImage, makeUserImageResolver, _test } = require('./presentationRenderer');
const houseStyle = require('../core/documents/documentHouseStyle');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#a03b3b"/></svg>').toString('base64')}`;

async function contentLayout(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    for (const n of Object.keys(zip.files).filter((f) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))) {
        const xml = await zip.file(n).async('string');
        if (xml.includes('<p:cSld name="BF_CONTENT">')) return xml;
    }
    throw new Error('no content layout');
}

test('a markdown outline becomes a .pptx; warnings from the deck model are passed through', async () => {
    const out = await renderPresentation({ content: '# Hallo\n\nSub\n\n## Een\n- a\n\n![x](https://example.com/a.png)\n\n## Twee\n> Q' });
    assert.strictEqual(out.format, 'pptx');
    assert.strictEqual(out.extension, 'pptx');
    assert.strictEqual(out.contentType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.strictEqual(out.slideCount, 3);
    assert.strictEqual(out.marking, null);
    assert.strictEqual(out.houseStyle, false, 'no org → neutral theme');
    assert.ok(out.warnings.some((w) => /example\.com/.test(w)));
});

test('the org house style paints the deck; houseStyle:false is the opt-out', async () => {
    styles.set('org_document_style_org-a', JSON.stringify({ enabled: true, accent: '#5a1e96', companyName: 'Paars BV', logoDataUrl: SVG }));
    houseStyle.invalidate('org-a');
    const themed = await renderPresentation({ deck: { title: 'T', slides: [{ title: 'S', bullets: ['x'] }] }, orgId: 'org-a' });
    assert.strictEqual(themed.houseStyle, true);
    const layout = await contentLayout(themed.buffer);
    assert.match(layout, /5A1E96/);
    assert.match(layout, /Paars BV/);
    assert.match(layout, /<p:pic>/, 'the svg logo was rasterised and placed');

    const plain = await renderPresentation({ deck: { title: 'T', slides: [{ title: 'S', bullets: ['x'] }] }, orgId: 'org-a', houseStyle: false });
    assert.strictEqual(plain.houseStyle, false);
    assert.doesNotMatch(await contentLayout(plain.buffer), /5A1E96|Paars BV/);
});

test('toPptxImage: png passes through, svg/webp are rasterised to png, anything else is null', async () => {
    assert.strictEqual(await toPptxImage(PNG), PNG);
    assert.match(await toPptxImage(SVG), /^data:image\/png;base64,/);
    assert.strictEqual(await toPptxImage('data:text/plain;base64,aGk='), null);
    assert.strictEqual(await toPptxImage('https://example.com/a.png'), null);
});

test('slide images go through the injected resolver; a null answer degrades the slide with a warning', async () => {
    const calls = [];
    const resolveImage = async (ref) => { calls.push(ref); return ref.storageKey === 'users/u1/images/ok.png' ? PNG : null; };
    const out = await renderPresentation({
        deck: { title: 'T', slides: [
            { title: 'ok', image: { url: '/api/storage/file/users/u1/images/ok.png' } },
            { title: 'gone', image: { url: 'users/u1/images/missing.png' }, bullets: ['still here'] },
            { title: 'remote', image: { url: 'https://example.com/x.png' } },
        ] },
        resolveImage,
    });
    assert.deepStrictEqual(calls.map((c) => c.storageKey), ['users/u1/images/ok.png', 'users/u1/images/missing.png'], 'the remote reference never reaches the resolver');
    assert.ok(out.warnings.some((w) => /slide 2/.test(w) && /left out/.test(w)));
    const zip = await JSZip.loadAsync(out.buffer);
    assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /<p:pic>/);
    assert.doesNotMatch(await zip.file('ppt/slides/slide3.xml').async('string'), /<p:pic>/);
    assert.match(await zip.file('ppt/slides/slide3.xml').async('string'), /still here/);
});

test('makeUserImageResolver only reads the caller\'s own storage prefix and never traverses', async () => {
    const resolve = makeUserImageResolver('u1');
    assert.strictEqual(await resolve({ dataUrl: PNG }), PNG);
    assert.strictEqual(await resolve({ storageKey: 'users/u2/images/a.png' }), null);
    assert.strictEqual(await resolve({ storageKey: 'users/u1/../u2/images/a.png' }), null);
    assert.strictEqual(await resolve({ storageKey: 'shared/x.png' }), null);
    assert.strictEqual(await resolve(null), null);
});

test('a marking is written to the file properties and reported; a switched-off one is not', async () => {
    const marking = { enabled: true, org_name: 'Org', provider: 'claude', generated_at: '2026-09-18T00:00:00Z', automation_id: 'auto1', footer_text: 'Generated with AI — Org' };
    const out = await renderPresentation({ deck: { title: 'T', slides: [{ title: 'S', bullets: ['x'] }] }, marking });
    assert.deepStrictEqual(out.marking, { visible: true, metadata: true });
    const core = await (await JSZip.loadAsync(out.buffer)).file('docProps/core.xml').async('string');
    assert.match(core, /AIGenerated=true/);
    assert.match(core, /AIProvider=claude/);
    assert.match(core, /BeeFlowAutomation=auto1/);
    assert.match(await contentLayout(out.buffer), /Generated with AI — Org/);

    const off = await renderPresentation({ deck: { title: 'T', slides: [{ title: 'S' }] }, marking: { ...marking, enabled: false } });
    assert.strictEqual(off.marking, null);
    assert.strictEqual(_test.flattenMarking({ ...marking, footer_text: '' }), null, 'no footer sentence → no marking');
});

test('format:pdf renders the same deck as a PDF (pdfkit fallback here, degraded and said so)', async () => {
    const out = await renderPresentation({ deck: { title: 'PDF deck', slides: [{ title: 'S', bullets: ['x'] }] }, format: 'pdf' });
    assert.strictEqual(out.format, 'pdf');
    assert.strictEqual(out.contentType, 'application/pdf');
    assert.strictEqual(out.degraded, true);
    assert.strictEqual(out.buffer.subarray(0, 4).toString(), '%PDF');
    assert.strictEqual(out.slideCount, 2);
});

test('an already-normalised deck is not normalised twice; an empty one is a document_empty error', async () => {
    const { normalizeDeck } = require('../core/documents/deckModel');
    const deck = normalizeDeck({ title: 'T', slides: [{ title: 'S' }] });
    const out = await renderPresentation({ deck });
    assert.strictEqual(out.slideCount, 2);
    await assert.rejects(renderPresentation({ content: '   ' }), (e) => e.errorClass === 'document_empty');
    await assert.rejects(renderPresentation({ deck: 7 }), (e) => e.errorClass === 'deck_invalid');
});

test('a per-deck logo reference is read through the resolver; "none" drops the house-style logo; an unreadable one is left out with a warning', async () => {
    styles.set('org_document_style_org-logo', JSON.stringify({ enabled: true, accent: '#123A5E', companyName: 'Org', logoDataUrl: PNG, logoWidthMm: 20 }));
    const calls = [];
    const resolveImage = async (ref) => { calls.push(ref.storageKey); return ref.storageKey === 'users/u1/images/brand.png' ? PNG : null; };
    const deck = { title: 'T', slides: [{ title: 'a', bullets: ['x'] }] };
    const own = await renderPresentation({ deck, orgId: 'org-logo', theme: { logo: 'users/u1/images/brand.png', logoPlacement: 'corner' }, resolveImage });
    assert.deepStrictEqual(calls, ['users/u1/images/brand.png']);
    assert.strictEqual(own.warnings.length, 0);
    const layout = await (async () => { const z = await JSZip.loadAsync(own.buffer); for (const n of Object.keys(z.files)) { if (/slideLayouts\/slideLayout\d+\.xml$/.test(n)) { const x = await z.file(n).async('string'); if (x.includes('name="BF_CONTENT"')) return x; } } return ''; })();
    assert.match(layout, /<p:pic>/, 'the corner logo is on the content master');
    const none = await renderPresentation({ deck, orgId: 'org-logo', theme: { logo: 'none' }, resolveImage });
    const noneLayout = await (async () => { const z = await JSZip.loadAsync(none.buffer); for (const n of Object.keys(z.files)) { if (/slideLayouts\/slideLayout\d+\.xml$/.test(n)) { const x = await z.file(n).async('string'); if (x.includes('name="BF_CONTENT"')) return x; } } return ''; })();
    assert.doesNotMatch(noneLayout, /<p:pic>/);
    const gone = await renderPresentation({ deck, orgId: 'org-logo', theme: { logo: 'users/u1/images/missing.png' }, resolveImage });
    assert.ok(gone.warnings.some((w) => /logo could not be resolved/.test(w)));
    const remote = await renderPresentation({ deck, orgId: 'org-logo', theme: { logo: 'https://example.com/logo.png' }, resolveImage });
    assert.strictEqual(calls.length, 2, 'a remote reference never reaches the resolver');
    assert.ok(remote.warnings.some((w) => /deck logo must be/.test(w)));
});

test('knockoutWhiteBackground: a logo on a white card loses the card, white inside the mark stays, transparent or coloured images are untouched', async () => {
    const sharp = require('sharp');
    const { knockoutWhiteBackground } = require('./presentationRenderer');
    // 20×20 white card with a 10×10 dark square in the middle that has a 2×2 white hole
    const w = 20; const h = 20;
    const raw = Buffer.alloc(w * h * 4, 255);
    for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) { const i = (y * w + x) * 4; raw[i] = 20; raw[i + 1] = 20; raw[i + 2] = 20; }
    for (let y = 9; y < 11; y += 1) for (let x = 9; x < 11; x += 1) { const i = (y * w + x) * 4; raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; }
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const out = await knockoutWhiteBackground(`data:image/png;base64,${png.toString('base64')}`);
    const { data } = await sharp(Buffer.from(out.slice(out.indexOf(',') + 1), 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = (x, y) => data[(y * w + x) * 4 + 3];
    assert.strictEqual(alpha(0, 0), 0, 'the card is gone');
    assert.strictEqual(alpha(19, 19), 0);
    assert.strictEqual(alpha(7, 7), 255, 'the mark stays');
    assert.strictEqual(alpha(9, 9), 255, 'the white hole inside the mark is kept');
    // A coloured card is not a "white background"
    const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 60, b: 200, alpha: 1 } } }).png().toBuffer();
    const blueUrl = `data:image/png;base64,${blue.toString('base64')}`;
    assert.strictEqual(await knockoutWhiteBackground(blueUrl), blueUrl);
});
