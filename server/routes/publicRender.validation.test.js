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

const page = { translations: ['en', 'nl'], snapshot: {} };

const MOCKS = {
    '../stores/cmsStore': {
        getDefaultLocale: async () => 'en',
        getEffectivePublished: async (siteId, slug) => (slug === 'missing' || slug === 'retired-page' ? { found: false } : {
            found: true, design: {}, header: {},
            page: { id: 'p1', slug, title: 'Pricing', blocks: [], isHomepage: slug === 'home' },
        }),
        getPublishedSnapshot: async () => page.snapshot,
        // Five posts, two per page: pages 1-3 exist.
        getEffectiveBlog: async (siteId, { page: asked = 1 }) => {
            const pageCount = 3;
            return {
                found: true, design: {}, header: {}, pages: [],
                page: { id: null, slug: 'blog', title: 'Blog', seo: {}, blocks: [] },
                blog: { view: 'index', page: Math.min(pageCount, Math.max(1, asked)), pageCount, locales: ['en'], posts: [] },
            };
        },
    },
    '../stores/configStore': { getConfig: async () => 'site-1' },
    '../usecases/liveSitemap.mts': { siteLocales: async () => ({ defaultLocale: 'en', locales: ['en', 'nl'] }), liveSitemapXml: async () => '' },
    '../core/seo/blog': { buildBlogHead: () => '<title>Blog</title>', renderBlogBody: () => '<main>Blog</main>', buildFeed: () => '' },
    '../core/seo/head': { buildHead: () => '<title>Pricing</title>' },
    '../core/seo/renderBlocks': { renderBlocksWithHints: () => ({ html: '<main>Pricing</main>', heroImage: null, headLinks: [] }), PREHYDRATE_CSS: '' },
    '../core/seo/shell': { getShell: async () => '<html><head></head><body><div id="root"></div></body></html>' },
    '../core/seo/inject': { injectIntoShell: (shell, { body }) => shell.replace('<div id="root"></div>', `<div id="root">${body}</div>`) },
    '../core/seo/sitemap': { buildSitemap: () => '', buildRobots: () => '', buildLlmsTxt: () => '' },
    '../i18n/pageLocales': { localesForPage: () => page.translations },
    '../core/seo/legacySlugs': { LEGACY_SLUGS: {}, GONE_SLUGS: new Set(['retired-page']) },
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
function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const lower = Object.fromEntries(Object.entries({ host: 'beeflow.test', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname,
            query: querystring.parse(search), headers: lower, protocol: 'https',
            get(h) { return lower[h.toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headers: {},
            status(c) { this.statusCode = c; return this; },
            type() { return this; },
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            append(k, v) { const key = String(k).toLowerCase(); this.headers[key] = [...[].concat(this.headers[key] || []), v]; return this; },
            redirect(status, location) { this.statusCode = status; this.location = location; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
        };
        router(req, res, (err) => (err ? reject(err) : reject(new Error(`fell through: GET ${url}`))));
    });
}

test.beforeEach(() => { page.translations = ['en', 'nl']; page.snapshot = {}; delete process.env.INDEXNOW_KEY; });

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

test('a blog address with ?locale= is consolidated onto its path URL as well', async () => {
    // Pages were consolidated; blog posts answered 200 on every ?locale= form,
    // so Search Console listed /blog/x, /blog/x?locale=nl and /nl/blog/x?locale=en.
    const res = await get('/blog/some-post?locale=nl&utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/nl/blog/some-post?utm_source=news');
    const index = await get('/nl/blog?locale=en');
    assert.strictEqual(index.statusCode, 301);
    assert.strictEqual(index.location, '/blog');
});

test('a Dutch browser on / is sent to /nl, never cached by a shared cache', async () => {
    const res = await get('/?utm_source=news', { 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.location, '/nl?utm_source=news');
    assert.match(res.headers['cache-control'], /private/);
    assert.match(res.headers['cache-control'], /no-store/);
});

test('/ stays English for an English browser and for a crawler without Accept-Language', async () => {
    const en = await get('/', { 'Accept-Language': 'en-GB,en;q=0.9' });
    assert.strictEqual(en.statusCode, 200);
    assert.match(String(en.headers.vary), /Accept-Language/);
    const bot = await get('/');
    assert.strictEqual(bot.statusCode, 200);
});

test('picking English on the site sticks: the ?locale= redirect sets the cookie and / honours it', async () => {
    const pick = await get('/nl?locale=en', { 'Accept-Language': 'nl-NL,nl' });
    assert.strictEqual(pick.statusCode, 301);
    assert.strictEqual(pick.location, '/');
    assert.match(String(pick.headers['set-cookie']), /bf_site_locale=en/);
    const back = await get('/', { 'Accept-Language': 'nl-NL,nl', Cookie: 'bf_site_locale=en' });
    assert.strictEqual(back.statusCode, 200);
});

test('/legal/<doc> redirects to the CMS page of that name, locale kept', async () => {
    const res = await get('/legal/imprint');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/imprint');
    const nl = await get('/nl/legal/dpa');
    assert.strictEqual(nl.location, '/nl/dpa');
    const kept = await get('/legal/dpa?utm_source=news');
    assert.strictEqual(kept.location, '/dpa?utm_source=news');
});

test('/privacy and /terms are served from the CMS like any other page', async () => {
    for (const p of ['/privacy', '/terms']) {
        const res = await get(p);
        assert.strictEqual(res.statusCode, 200, p);
        assert.match(res.body, /<main>Pricing<\/main>/);
    }
});

test('a URL no page ever had answers 404, flagged for nginx so it is not turned into a 200 shell', async () => {
    const res = await get('/missing');
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.headers['x-beeflow-render'], 'not-found');
});

test('only a slug on the retired list answers 410', async () => {
    const res = await get('/nl/retired-page');
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.headers['x-beeflow-render'], 'not-found');
});

test('a managed redirect answers before the page, carries the query and the locale prefix', async () => {
    page.snapshot = { redirects: [{ from: '/pricing', to: '/plans', status: 301, external: false }], site: { pages: [] } };
    const res = await get('/pricing?utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/plans?utm_source=news');
    const nl = await get('/nl/pricing');
    assert.strictEqual(nl.location, '/nl/plans');
});

test('a page that exists at the address wins over a redirect from it', async () => {
    page.snapshot = { redirects: [{ from: '/pricing', to: '/plans', status: 301, external: false }], site: { pages: [{ slug: 'pricing' }] } };
    const res = await get('/pricing');
    assert.strictEqual(res.statusCode, 200);
});

test('the homepage under its own slug moves to the root of its locale, query kept', async () => {
    const res = await get('/home?utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/?utm_source=news');
    const nl = await get('/nl/home');
    assert.strictEqual(nl.statusCode, 301);
    assert.strictEqual(nl.location, '/nl');
});

test('blog pages 2 and 3 exist; page 4, page 0 and a negative page answer 404', async () => {
    for (const ok of ['/blog', '/blog?page=2', '/blog?page=3']) {
        assert.strictEqual((await get(ok)).statusCode, 200, ok);
    }
    for (const gone of ['/blog?page=4', '/blog?page=0', '/blog?page=-1', '/blog?page=99']) {
        const res = await get(gone);
        assert.strictEqual(res.statusCode, 404, gone);
        assert.strictEqual(res.headers['x-beeflow-render'], 'not-found', gone);
    }
});

test('a managed redirect asked with ?locale= lands on the final address in ONE 301', async () => {
    page.snapshot = { redirects: [{ from: '/pricing', to: '/plans', status: 301, external: false }], site: { pages: [] } };
    const res = await get('/pricing?locale=nl&utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    // Was /plans?locale=nl&utm_source=news, which the locale consolidation then moved again.
    assert.strictEqual(res.location, '/nl/plans?utm_source=news');
    assert.match(String(res.headers['set-cookie']), /bf_site_locale=nl/);
    assert.match(res.headers['cache-control'], /no-store/);
    const en = await get('/nl/pricing?locale=en');
    assert.strictEqual(en.location, '/plans');
});

test('a managed redirect with ?locale= to a page without that translation goes straight to the default language', async () => {
    page.translations = ['en'];
    page.snapshot = { redirects: [{ from: '/pricing', to: '/plans', status: 301, external: false }], site: { pages: [{ id: 'p9', slug: 'plans' }] } };
    const res = await get('/pricing?locale=nl');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/plans');
});

test('/index.html moves to / (and a locale index to that locale root), query kept', async () => {
    const res = await get('/index.html?utm_source=news');
    assert.strictEqual(res.statusCode, 301);
    assert.strictEqual(res.location, '/?utm_source=news');
    assert.strictEqual((await get('/nl/index.html')).location, '/nl');
    assert.strictEqual((await get('/blog/index.html')).location, '/blog');
});

test('an unknown .xml or .txt answers 404, never the SPA shell with a 200', async () => {
    for (const p of ['/sitemap_index.xml', '/ads.txt', '/nl/feed.xml', '/wp-sitemap.xml', '/humans.txt']) {
        const res = await get(p);
        assert.strictEqual(res.statusCode, 404, p);
        assert.strictEqual(res.headers['x-beeflow-render'], 'not-found', p);
        assert.match(res.headers['cache-control'], /max-age/);
    }
});

test('the IndexNow key file is served at /<key>.txt only while INDEXNOW_KEY is set', async () => {
    const key = 'indexnow-test-key';
    assert.strictEqual((await get(`/${key}.txt`)).statusCode, 404);
    process.env.INDEXNOW_KEY = key;
    const res = await get(`/${key}.txt`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, key);
    assert.strictEqual((await get('/other-key-0000.txt')).statusCode, 404);
});
