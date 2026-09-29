/**
 * What the server-rendered marketing pages accept, and what their redirects
 * carry along (routes/publicRender.js).
 *
 * No schema here, on purpose: these are pages a browser navigates to, and the
 * query belongs to whoever built the link (utm_*, gclid, …) — a 400 would turn
 * a paid click into an error page. What this file pins instead:
 *
 *   - a query parameter the route has never heard of still gets the page;
 *   - the two 301s carry the query as SENT: a repeated key stays repeated.
 *     They used to rebuild it from req.query, and URLSearchParams wrote
 *     Express's array back as one comma-joined value (?tag=a%2Cb);
 *   - neither 301 carries `locale` itself, or the next request acts on it again.
 *
 * Run: cd server && node --test routes/publicRender.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const querystring = require('node:querystring');

const page = { translations: ['en', 'nl'] };

const MOCKS = {
    '../stores/cmsStore': {
        getDefaultLocale: async () => 'en',
        getEffectivePublished: async (siteId, slug) => ({
            found: true, design: {}, header: {},
            page: { id: 'p1', slug, title: 'Pricing', blocks: [], isHomepage: false },
        }),
        getPublishedSnapshot: async () => ({}),
    },
    '../stores/configStore': { getConfig: async () => 'site-1' },
    '../stores/languageStore': { getAvailableLocales: async () => [{ code: 'en' }, { code: 'nl' }] },
    '../core/seo/head': { buildHead: () => '<title>Pricing</title>' },
    '../core/seo/renderBlocks': { renderBlocks: () => '<main>Pricing</main>', PREHYDRATE_CSS: '' },
    '../core/seo/shell': { getShell: async () => '<html><head></head><body><div id="root"></div></body></html>' },
    '../core/seo/inject': { injectIntoShell: (shell, { body }) => shell.replace('<div id="root"></div>', `<div id="root">${body}</div>`) },
    '../core/seo/sitemap': { buildSitemap: () => '', buildRobots: () => '', buildLlmsTxt: () => '' },
    '../core/seo/locales': { localesForPage: () => page.translations },
    '../core/seo/legacySlugs': { LEGACY_SLUGS: {} },
    '../core/cms/legacyContent': { synthesizeLegacyContent: () => ({}) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:public-render-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]publicRender\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./publicRender');
test.after(() => { Module._resolveFilename = originalResolve; });

/** A GET as Express hands it over: req.query parsed the way its 'simple' parser does. */
function get(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname,
            query: querystring.parse(search), headers: {}, protocol: 'https',
            get(h) { return h.toLowerCase() === 'host' ? 'beeflow.test' : undefined; },
        };
        const res = {
            statusCode: 200, headers: {},
            status(c) { this.statusCode = c; return this; },
            type() { return this; },
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            redirect(status, location) { this.statusCode = status; this.location = location; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
        };
        router(req, res, (err) => (err ? reject(err) : reject(new Error(`fell through: GET ${url}`))));
    });
}

test.beforeEach(() => { page.translations = ['en', 'nl']; });

test('a parameter the route has never heard of still gets the page', async () => {
    const res = await get('/pricing?gclid=abc&utm_source=news');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /<main>Pricing<\/main>/);
});

test('the ?locale= consolidation keeps a repeated key repeated, not comma-joined', async () => {
    const res = await get('/pricing?locale=nl&utm_source=news&tag=a&tag=b');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/nl/pricing?utm_source=news&tag=a&tag=b');
});

test('the untranslated-page redirect keeps a repeated key repeated too', async () => {
    page.translations = ['en'];
    const res = await get('/nl/pricing?tag=a&tag=b');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/pricing?tag=a&tag=b');
});

test('the untranslated-page redirect drops locale, instead of starting a chain of three 301s', async () => {
    page.translations = ['en'];
    const res = await get('/nl/pricing?locale=nl&utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    // Carried along, ?locale=nl sent the visitor back to /nl/pricing first.
    assert.strictEqual(res.location, '/pricing?utm_source=news');
});

test('the consolidation still drops locale itself and keeps every other key', async () => {
    const res = await get('/pricing?utm_campaign=q4&locale=NL-be');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/nl/pricing?utm_campaign=q4');
});
