/**
 * The conditional-request path.
 *
 * A weekly refresh of a 200-page site that re-embedded every page would spend
 * 200 embedding calls a week to learn that nothing happened. The 304 is what
 * makes that one cheap round trip instead, so the validator round-tripping
 * correctly is the assertion that matters — and getting it BACKWARDS (sending
 * an ETag as If-Modified-Since) fails open: the server answers 200 every time
 * and the saving silently disappears.
 *
 * Run: node --test --test-force-exit core/kb/sources/webpage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Stub the guard, not the network: this file is about WHAT is sent, and the
// guard's own behaviour is pinned by routes/knowledgeBases.ssrf.test.js.
const calls = [];
let respond = () => ({ status: 200, headers: {}, body: '' });

const MOCK_ID = 'mock:webpage:fetchGuard';
require.cache[MOCK_ID] = {
    id: MOCK_ID, filename: MOCK_ID, loaded: true,
    exports: {
        guardedFetch: async (url, opts = {}) => {
            calls.push({ url, headers: opts.headers || {} });
            const r = respond(url, opts);
            return {
                status: r.status,
                ok: r.ok !== undefined ? r.ok : r.status < 400,
                url: r.url || url,
                headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null },
                text: async () => r.body || '',
            };
        },
    },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const isWebpageAdapter = parent && /webpage\.js$/.test(parent.filename)
        && parent.filename.includes('kb') && parent.filename.includes('sources');
    if (isWebpageAdapter && request === '../fetchGuard') return MOCK_ID;
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const webpage = require('./webpage');

const SOURCE = { id: 's1', kind: 'webpage', config: { url: 'https://example.com/terms' } };
const ITEM = { externalId: 'https://example.com/terms', url: 'https://example.com/terms' };
const HTML = { 'content-type': 'text/html' };
const CTX = { log: () => {} };

function reset() { calls.length = 0; }

test('a page with no stored validator is fetched unconditionally', async () => {
    reset();
    respond = () => ({ status: 200, headers: { ...HTML, etag: '"v1"' }, body: '<html><body><h1>Terms</h1><p>Thirty days.</p></body></html>' });
    const out = await webpage.fetch(ITEM, null, CTX, {});
    assert.ok(out.content.includes('Thirty days'));
    assert.strictEqual(out.sourceModifiedAt, '"v1"', 'the validator must be kept for next time');
    assert.ok(!('If-None-Match' in calls[0].headers));
    assert.ok(!('If-Modified-Since' in calls[0].headers));
});

test('a stored ETag comes back as If-None-Match', async () => {
    reset();
    respond = () => ({ status: 304, ok: false, headers: {} });
    const out = await webpage.fetch(ITEM, { source_modified_at: '"v1"' }, CTX, {});
    assert.strictEqual(out, null, '304 means unchanged, and the engine must do nothing');
    assert.strictEqual(calls[0].headers['If-None-Match'], '"v1"');
});

test('a weak ETag is still an ETag', async () => {
    reset();
    respond = () => ({ status: 304, ok: false, headers: {} });
    await webpage.fetch(ITEM, { source_modified_at: 'W/"v1"' }, CTX, {});
    assert.strictEqual(calls[0].headers['If-None-Match'], 'W/"v1"');
    assert.ok(!('If-Modified-Since' in calls[0].headers), 'never as a date — that fails open');
});

test('a stored date comes back as If-Modified-Since', async () => {
    reset();
    respond = () => ({ status: 304, ok: false, headers: {} });
    await webpage.fetch(ITEM, { source_modified_at: '2026-08-01T00:00:00.000Z' }, CTX, {});
    assert.strictEqual(calls[0].headers['If-Modified-Since'], 'Sat, 01 Aug 2026 00:00:00 GMT');
    assert.ok(!('If-None-Match' in calls[0].headers));
});

test('a Last-Modified answer is kept when there is no ETag', async () => {
    reset();
    respond = () => ({ status: 200, headers: { ...HTML, 'last-modified': 'Sat, 01 Aug 2026 00:00:00 GMT' }, body: '<html><body>x y z</body></html>' });
    const out = await webpage.fetch(ITEM, null, CTX, {});
    assert.strictEqual(out.sourceModifiedAt, 'Sat, 01 Aug 2026 00:00:00 GMT');
});

test('an ETag wins over Last-Modified when a server sends both', async () => {
    reset();
    respond = () => ({ status: 200, headers: { ...HTML, etag: '"v2"', 'last-modified': 'Sat, 01 Aug 2026 00:00:00 GMT' }, body: '<html><body>x y z</body></html>' });
    const out = await webpage.fetch(ITEM, null, CTX, {});
    assert.strictEqual(out.sourceModifiedAt, '"v2"', 'the stronger validator');
});

test('isUnchanged never guesses — the server answers that', () => {
    // Returning true on a stale guess freezes a page that changed.
    assert.strictEqual(webpage.isUnchanged({ externalId: 'x' }, { source_modified_at: '"v1"' }), false);
});

test('a failed fetch is an error, not silently empty content', async () => {
    reset();
    respond = () => ({ status: 503, ok: false, headers: {} });
    await assert.rejects(() => webpage.fetch(ITEM, null, CTX, {}), /HTTP 503/);
});

test('a content type that is not text is refused rather than embedded', async () => {
    reset();
    respond = () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: ' ' });
    await assert.rejects(() => webpage.fetch(ITEM, null, CTX, {}), /Unsupported content type/);
});

test('a plain page enumerates as itself and nothing else', async () => {
    reset();
    const items = await webpage.enumerate(SOURCE, CTX);
    assert.deepStrictEqual(items.map(i => i.externalId), ['https://example.com/terms']);
    assert.strictEqual(calls.length, 0, 'enumerate must not fetch a plain page');
});

test('a crawl source walks the sitemap, entry page first, capped by maxPages', async () => {
    reset();
    respond = (url) => {
        if (url.endsWith('/robots.txt')) return { status: 200, headers: {}, body: 'Sitemap: https://example.com/sitemap.xml' };
        if (url.endsWith('/sitemap.xml')) {
            return {
                status: 200, headers: {},
                body: ['a', 'b', 'c', 'd'].map(p => `<url><loc>https://example.com/${p}</loc></url>`).join(''),
            };
        }
        return { status: 404, ok: false, headers: {} };
    };
    const items = await webpage.enumerate(
        { ...SOURCE, config: { url: 'https://example.com/terms', crawl: { maxPages: 3 } } },
        CTX,
    );
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].externalId, 'https://example.com/terms', 'the entry page always belongs');
});

test('a crawl cannot exceed the hard ceiling however its config was edited', async () => {
    reset();
    respond = (url) => {
        if (url.endsWith('/sitemap.xml')) {
            const locs = Array.from({ length: 900 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join('');
            return { status: 200, headers: {}, body: locs };
        }
        return { status: 404, ok: false, headers: {} };
    };
    const items = await webpage.enumerate(
        // A value clamped at write time can still be edited in the database.
        { ...SOURCE, config: { url: 'https://example.com/terms', crawl: { maxPages: 100000 } } },
        CTX,
    );
    assert.ok(items.length <= webpage.MAX_CRAWL_PAGES, `${items.length} > ${webpage.MAX_CRAWL_PAGES}`);
});

test('a site with no sitemap contributes its entry page, not a link crawl', async () => {
    reset();
    respond = () => ({ status: 404, ok: false, headers: {} });
    const items = await webpage.enumerate(
        { ...SOURCE, config: { url: 'https://example.com/terms', crawl: { maxPages: 50 } } },
        CTX,
    );
    assert.deepStrictEqual(items.map(i => i.externalId), ['https://example.com/terms']);
});

test('a nested sitemap index is followed, and its own entries are not pages', async () => {
    reset();
    respond = (url) => {
        if (url.endsWith('/robots.txt')) return { status: 404, ok: false, headers: {} };
        if (url.endsWith('/sitemap.xml')) {
            return { status: 200, headers: {}, body: '<sitemap><loc>https://example.com/pages.xml</loc></sitemap>' };
        }
        if (url.endsWith('/pages.xml')) {
            return { status: 200, headers: {}, body: '<url><loc>https://example.com/deep</loc></url>' };
        }
        return { status: 404, ok: false, headers: {} };
    };
    const items = await webpage.enumerate(
        { ...SOURCE, config: { url: 'https://example.com/terms', crawl: { maxPages: 20 } } },
        CTX,
    );
    const ids = items.map(i => i.externalId);
    assert.ok(ids.includes('https://example.com/deep'), 'the nested sitemap must be walked');
    assert.ok(!ids.some(u => u.endsWith('.xml')), 'a sitemap is not a page to embed');
});

test('every URL goes through the guard, sitemaps included', async () => {
    // A URL screened once when someone added the source is re-fetched every
    // week by a job with nobody watching, and DNS can say something different
    // by then. Nothing here may reach the network another way.
    reset();
    respond = () => ({ status: 404, ok: false, headers: {} });
    await webpage.enumerate({ ...SOURCE, config: { url: 'https://example.com/t', crawl: { maxPages: 5 } } }, CTX);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(c => /^https:\/\//.test(c.url)), 'every call went through guardedFetch');
});

test('only manual and schedule are offered — a page has no change event', () => {
    assert.deepStrictEqual(webpage.supportsModes, ['manual', 'schedule']);
});
