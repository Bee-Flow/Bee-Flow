// @typecheck
/**
 * The generated share-image route (routes/cmsOgImage.js): which requests get a
 * card, and what is cached. Handlers are called with a fake req/res; the stores
 * are stubbed with mock.method on the shared module objects (no module mocking).
 *
 * Run: node --test routes/cmsOgImage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const h = require('../testUtils/routeHarness');

h.recordDb();
const cmsStore = require('../stores/cmsStore');
const cmsShared = require('./cmsShared');

const PUBLISHED = '2026-10-16T10:00:00.000Z';
const state = { live: 'pj_aaaa1111', snapshot: null, eff: null };

mock.method(cmsShared, 'getLiveSiteId', async () => state.live);
mock.method(cmsStore, 'getPublishedSnapshot', async () => state.snapshot);
mock.method(cmsStore, 'getDefaultLocale', async () => 'en');
mock.method(cmsStore, 'getEffectivePublished', async (siteId, slug) => (slug === 'pricing' ? state.eff : { found: false }));

const { serveOgImage, eyebrowOf, publishedLocales } = require('./cmsOgImage');
const VERSION = String(Date.parse(PUBLISHED));

test.beforeEach(() => {
    state.live = 'pj_aaaa1111';
    state.snapshot = { publishedAt: PUBLISHED, site: { name: 'Voorbeeld' }, siteLocaleOverrides: { nl: {} }, pageLocaleOverrides: {} };
    state.eff = {
        found: true,
        design: { colors: {}, shareImage: { template: 'brand', motif: true } },
        header: { logoText: 'Voorbeeld' },
        page: { slug: 'pricing', title: 'Prijzen', seo: {}, blocks: [{ enabled: true, content: { eyebrow: 'Tarieven' } }] },
    };
});

async function call(locale, slug, { query = {}, headers = {} } = {}) {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.type = (t) => { res.headers['content-type'] = t; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.end = () => res;
    let error = null;
    try { await serveOgImage({ params: [locale, slug], query, headers }, res); } catch (e) { error = e; }
    return { res, error };
}

test('a published page gets a PNG; a versioned URL is cached for a year, an unversioned one briefly', async () => {
    const versioned = await call('en', 'pricing', { query: { v: VERSION } });
    assert.strictEqual(versioned.error, null);
    assert.strictEqual(versioned.res.headers['content-type'], 'image/png');
    assert.strictEqual(versioned.res.body.subarray(1, 4).toString(), 'PNG');
    assert.match(versioned.res.headers['cache-control'], /immutable/);
    const plain = await call('en', 'pricing');
    assert.match(plain.res.headers['cache-control'], /max-age=300/);
});

test('If-None-Match answers 304 without drawing', async () => {
    const first = await call('en', 'pricing');
    const again = await call('en', 'pricing', { headers: { 'if-none-match': first.res.headers.etag } });
    assert.strictEqual(again.res.statusCode, 304);
    assert.strictEqual(again.res.body, undefined);
});

test('404 for: no live site, never published, unknown page, a language the site does not publish', async () => {
    state.live = null;
    assert.strictEqual((await call('en', 'pricing')).error.status, 404);
    state.live = 'pj_aaaa1111'; state.snapshot = null;
    assert.strictEqual((await call('en', 'pricing')).error.status, 404);
    state.snapshot = { publishedAt: PUBLISHED, siteLocaleOverrides: {}, pageLocaleOverrides: {} };
    assert.strictEqual((await call('en', 'missing')).error.status, 404);
    assert.strictEqual((await call('xx', 'pricing')).error.status, 404);
});

test('helpers: eyebrow of the first block that has one, locales from the snapshot', () => {
    assert.strictEqual(eyebrowOf({ blocks: [{ enabled: false, content: { eyebrow: 'Hidden' } }, { content: { eyebrow: ' Shown ' } }] }), 'Shown');
    assert.strictEqual(eyebrowOf({ blocks: [{ content: { eyebrow: 'x'.repeat(80) } }] }), '');
    const set = publishedLocales({ siteLocaleOverrides: { nl: {} }, pageLocaleOverrides: { p1: { de: {} } } }, 'en');
    assert.deepStrictEqual([...set].sort(), ['de', 'en', 'nl']);
});
