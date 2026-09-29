/**
 * The house-style route's presentation half: the option catalog the editor's
 * selects draw from, and the preview endpoint that resolves an UNSAVED style
 * into the complete deck theme — on the server, where the contrast rules
 * live, so the picture the editor shows is the deck the renderers build.
 *
 * Run: cd server && node --test --test-force-exit routes/studioDocuments.houseStyleDeck.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

const config = new Map();
const restore = installResolveStub({
    '../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: () => (_req, _res, next) => next(),
        hasPermission: async () => true,
    },
    '../../stores/configStore': {
        getConfig: async (k) => config.get(k) ?? null,
        setConfig: async (k, v) => { config.set(k, v); },
    },
    '../stores/documentStore': {},
    '../core/documents/renderFilledDocument': { houseStyleCssFor: async () => '', renderFilledDocument: async () => ({}) },
    '../compliance/marking': { resolveMarking: async () => null },
});
test.after(restore);
const router = require('./studioDocuments');

function dispatch(method, url, { body = {}, query = {}, user = 'owner', orgId = 'org-1' } = {}) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, query, headers: {}, session: user ? { user: { id: user, organizationId: orgId } } : null };
        const res = {
            statusCode: 200, headers: {},
            status(code) { this.statusCode = code; return this; },
            set(k, v) { this.headers[k] = v; return this; },
            json(data) { this.body = data; resolve(this); return this; },
            send(data) { this.body = data; resolve(this); return this; },
        };
        router(req, res, (e) => reject(e || new Error('Route not found')));
    });
}

test('GET /house-style carries the deck option catalog and a stored deck style', async () => {
    config.set('org_document_style_org-1', JSON.stringify({ enabled: true, accent: '#F5A623', ink: '#FAF7F2', deck: { preset: 'dark', tableStyle: 'lines' } }));
    const res = await dispatch('GET', '/house-style');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.deck.presets.map((p) => p.id), ['band', 'clean', 'bold', 'dark']);
    assert.ok(res.body.deck.fonts.includes('Georgia'));
    assert.equal(res.body.style.deck.preset, 'dark');
    assert.equal(res.body.style.deck.tableStyle, 'lines');
    assert.equal(res.body.style.deck.coverStyle, 'accent', 'every deck key present, defaults filled');
});

test('POST /house-style/preview-theme resolves an unsaved style with contrast enforced', async () => {
    const res = await dispatch('POST', '/house-style/preview-theme', {
        body: { style: { enabled: true, accent: '#F5A623', ink: '#FAF7F2', companyName: 'Bee Flow B.V.', deck: { preset: 'band', tableStyle: 'banded' } } },
    });
    assert.equal(res.statusCode, 200);
    const t = res.body.theme;
    assert.equal(t.preset, 'band');
    assert.equal(t.bandColor, '#F5A623');
    assert.equal(t.text, '#1A1D21', 'the near-white ink did not become the deck text');
    assert.equal(t.brandName, 'Bee Flow B.V.');
    assert.ok(Object.keys(t).length > 20, 'a complete theme, not a palette');
    // Overrides ride along for the "just this deck" preview.
    const over = await dispatch('POST', '/house-style/preview-theme', { body: { style: { enabled: true, accent: '#112233' }, overrides: { preset: 'bold' } } });
    assert.equal(over.body.theme.background, '#112233');
    // Anyone signed in may ask; nobody signed out.
    const anon = await dispatch('POST', '/house-style/preview-theme', { body: { style: {} }, user: null });
    assert.equal(anon.statusCode, 401);
});

test('POST /house-style/deck-template turns a .pptx into the template look; junk is refused with a code', async () => {
    const PptxGenJS = require('pptxgenjs');
    const sharp = require('sharp');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    const bg = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 36, channels: 4, background: { r: 15, g: 150, b: 224, alpha: 1 } } }).png().toBuffer()).toString('base64')}`;
    const slide = pptx.addSlide();
    slide.addImage({ data: bg, x: 0, y: 0, w: 10, h: 5.625 });
    slide.addText('Conf', { x: 1, y: 1, w: 3, h: 1, color: 'FFFFFF' });
    const bytes = await pptx.write({ outputType: 'nodebuffer' });
    const res = await dispatch('POST', '/house-style/deck-template', { body: { dataUrl: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`, name: 'conf.pptx' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 200));
    assert.equal(res.body.template.name, 'conf');
    assert.match(res.body.template.content.image, /^data:image\/jpeg/);
    // The preview endpoint resolves a style carrying it: white text on the blue, no band.
    const prev = await dispatch('POST', '/house-style/preview-theme', { body: { style: { enabled: true, accent: '#F5A623', ink: '#1A1A1A', deck: { template: res.body.template } } } });
    assert.equal(prev.body.theme.titleStyle, 'plain');
    assert.equal(prev.body.theme.text, '#FFFFFF');
    const bad = await dispatch('POST', '/house-style/deck-template', { body: { dataUrl: 'not a data url' } });
    assert.equal(bad.statusCode, 400);
    const empty = await dispatch('POST', '/house-style/deck-template', { body: { dataUrl: `data:application/octet-stream;base64,${Buffer.from('PK\u0003\u0004junk').toString('base64')}` } });
    assert.ok(empty.statusCode >= 400 && empty.body.code);
});
