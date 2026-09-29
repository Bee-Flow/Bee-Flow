/**
 * SSRF guard on the KB sitemap ingest (and re-index) fetches.
 *
 * Pre-fix, POST /:id/ingest/sitemap validated only `new URL(req.body.url).origin`
 * and then pulled robots.txt, every sitemap, every nested sitemap and every
 * page `<loc>` with the bare global fetch. The `<loc>` entries come out of a
 * sitemap the *caller* hosts, so they need not share the validated origin: a
 * sitemap on a public host could list `http://127.0.0.1:3101/...` and the body
 * of that internal response was converted to markdown and ingested into a
 * searchable KB. These tests pin that EVERY url is screened on its own merits
 * before a socket opens, not just the origin that was posted.
 *
 * '../core/kb/kbIngestionHelpers'.assertUrlIsPublic and '../utils/ssrfGuard'.safeFetch
 * are stubbed with recording doubles — the route must DELEGATE to them, so
 * delegation (not the guard internals, which utils/ssrfGuard.test.js covers) is
 * what's under test. The real global fetch is replaced with a throwing spy so
 * any bypass fails loudly.
 *
 * Run: cd server && node --test routes/knowledgeBases.ssrf.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    publicHosts: new Set(),   // hostnames the stubbed guard treats as public
    validated: [],            // every url handed to assertUrlIsPublic
    fetched: [],              // every url that actually reached safeFetch
    plainFetched: [],         // every url that reached the plain global fetch
    allowPlainFetch: false,   // opt-in: only the escape-hatch tests set this
    pages: {},                // url → { contentType, body }
    ingested: [],             // ingestDocument spy
};

function resetFx() {
    fx.publicHosts = new Set();
    fx.validated.length = 0;
    fx.fetched.length = 0;
    fx.plainFetched.length = 0;
    fx.allowPlainFetch = false;
    fx.pages = {};
    fx.ingested.length = 0;
}

function respondFor(u) {
    const page = fx.pages[u];
    if (!page) {
        return { ok: false, status: 404, url: u, headers: { get: () => '' }, text: async () => '' };
    }
    return {
        ok: true,
        status: 200,
        url: u,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? page.contentType : '') },
        text: async () => page.body,
    };
}

const mw = (req, res, next) => next();

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => ({ id, tenant_id: 't1', name: 'kb' }),
        isSystemKB: () => false,
        hashContent: (c) => `h${c.length}`,
        hasContentHash: async () => false,
        bumpKBVersion: async () => {},
    },
    '../stores/configStore': { getConfig: async () => null },
    '../stores/userStore': { getUser: async () => ({ organizationId: 'o1' }) },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => [],
        hasPermission: async () => true,
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => {},
        isOrgAdminRole: () => true,
        resolveUserGroups: async () => [],
    },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../core/serviceAuth': { getServiceHeaders: () => ({}) },
    '../support/kbAccess': { canAccessKB: async () => true, resolveIsOrgAdmin: async () => true },
    '../core/kb/kbIngestionHelpers': {
        getAzureIngestParams: async () => ({}),
        extractFileContent: async () => '',
        fetchUrlContent: async () => ({ content: '', title: '', resolvedUrl: '' }),
        deleteDocumentChunks: async () => {},
        ingestDocument: async (tenantId, kbId, content, title, sourceType, sourceUri) => {
            fx.ingested.push({ sourceUri, title, content });
            return { document: { id: 'd1' }, chunks: 1 };
        },
        // Stand-in for the real DNS-resolving guard: allow-list by hostname,
        // and record every url it is asked about so the tests can prove the
        // route screened each one individually.
        assertUrlIsPublic: async (u) => {
            fx.validated.push(u);
            let parsed;
            try { parsed = new URL(u); } catch (_) { throw new Error('Invalid URL'); }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error('Only HTTP/HTTPS URLs are allowed');
            }
            if (!fx.publicHosts.has(parsed.hostname)) {
                throw new Error(`URL ${parsed.hostname} resolves to a private/loopback address (${parsed.hostname})`);
            }
            return parsed;
        },
    },
    '../utils/ssrfGuard': {
        safeFetch: async (u) => {
            fx.fetched.push(u);
            return respondFor(u);
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-ssrf:${request}`;
    MOCK_IDS[request] = mockId;
    // The route handlers now live in routes/knowledgeBases/*.js, one level
    // below the facade at routes/knowledgeBases.js, so the same dependency is
    // written '../x' in the facade and '../../x' there. Register both, because
    // a stub key must match the require string as written in its own module.
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
// guardedFetch itself moved to core/kb/fetchGuard.js, where those same two
// dependencies are written './kbIngestionHelpers' and '../../utils/ssrfGuard'.
// The guard did not change — only its address — and this file is what proves
// the routes still go through it, so the stub keys follow it there.
MOCK_IDS['./kbIngestionHelpers'] = MOCK_IDS['../core/kb/kbIngestionHelpers'];

// Which modules see the stubs: the KB routers, and the guard they call.
// Deliberately narrow — a broad match would stub these for the whole server
// and the global-fetch tripwire below would stop meaning anything.
const STUBBED_PARENT = /(routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)|core[\\/]kb[\\/]fetchGuard\.js)$/;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && STUBBED_PARENT.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./knowledgeBases');

// Nothing in these routes may reach the network except through safeFetch —
// UNLESS a test has explicitly opted into the KB_ALLOW_PRIVATE_HOSTS escape
// hatch, which by design trades safeFetch for the plain fetch. resetFx() clears
// that opt-in, so the tripwire is armed for every other test in the file.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
    if (!fx.allowPlainFetch) throw new Error('global fetch called — SSRF guard bypassed');
    fx.plainFetched.push(u);
    return respondFor(u);
};

test.after(() => {
    Module._resolveFilename = originalResolve;
    globalThis.fetch = realFetch;
    delete process.env.KB_ALLOW_PRIVATE_HOSTS;
});

// A schema refusal travels as an error to the terminal handler, so the
// harness answers one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {}, session,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(request, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

const SESSION = { user: { id: 'u1' } };
const HTML = (title, body) => ({
    contentType: 'text/html; charset=utf-8',
    body: `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`,
});
const sitemapXml = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?><urlset>${locs.map(l => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

const INTERNAL = 'http://127.0.0.1:3101/api/admin/metrics';

// ═══ the finding: a <loc> off the validated origin ═══════════════════

test('sitemap <loc> pointing at an internal host is screened and never fetched', async () => {
    resetFx();
    fx.publicHosts.add('attacker.example');
    fx.pages['https://attacker.example/sitemap.xml'] = {
        contentType: 'application/xml',
        body: sitemapXml([INTERNAL, 'https://attacker.example/real-page']),
    };
    fx.pages['https://attacker.example/real-page'] = HTML('Real page', 'ordinary public content, long enough to ingest');

    const res = await dispatch({
        method: 'POST', url: '/kb1/ingest/sitemap',
        body: { url: 'https://attacker.example/' }, session: SESSION,
    });

    assert.strictEqual(res.statusCode, 200);
    // Screened on its own merits — not covered by the posted origin's check.
    assert.ok(fx.validated.includes(INTERNAL), 'internal <loc> was passed to assertUrlIsPublic');
    // ...and refused before any socket opened.
    assert.ok(!fx.fetched.includes(INTERNAL), 'internal <loc> must never reach safeFetch');
    assert.ok(!fx.ingested.some(d => d.sourceUri === INTERNAL), 'internal response must not be ingested');

    const internalDetail = res.body.details.find(d => d.url === INTERNAL);
    assert.strictEqual(internalDetail.status, 'error');
    assert.match(internalDetail.reason, /private\/loopback/);

    // The legitimate same-origin page is unaffected.
    assert.strictEqual(res.body.ingested, 1);
    assert.strictEqual(fx.ingested[0].sourceUri, 'https://attacker.example/real-page');
});

test('robots.txt and nested sitemaps are guarded too', async () => {
    resetFx();
    fx.publicHosts.add('attacker.example');
    fx.pages['https://attacker.example/robots.txt'] = {
        contentType: 'text/plain',
        // A Sitemap: line is caller-authored just like a <loc>.
        body: `Sitemap: http://169.254.169.254/latest/meta-data/\nSitemap: https://attacker.example/nested.xml\n`,
    };
    fx.pages['https://attacker.example/nested.xml'] = {
        contentType: 'application/xml',
        body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>http://10.0.0.5/internal-sitemap.xml</loc></sitemap></sitemapindex>`,
    };

    const res = await dispatch({
        method: 'POST', url: '/kb1/ingest/sitemap',
        body: { url: 'https://attacker.example/' }, session: SESSION,
    });

    assert.strictEqual(res.statusCode, 404, 'no pages found — every internal hop refused');
    assert.ok(fx.validated.includes('http://169.254.169.254/latest/meta-data/'));
    assert.ok(!fx.fetched.some(u => /169\.254\.169\.254|10\.0\.0\.5/.test(u)), 'no internal sitemap fetch');
});

// ═══ maxPages is caller-controlled — clamp it ════════════════════════

// The sitemap must be LARGER than every limit under test, or the assertions do
// not discriminate: with a four-page fixture "no limit at all" and "the 50-page
// default" both come out as 4, which is how an unclamped implementation passed
// the first version of these tests.
function seedSitemap(count) {
    resetFx();
    fx.publicHosts.add('site.example');
    const locs = Array.from({ length: count }, (_, i) => `https://site.example/p${i}`);
    fx.pages['https://site.example/sitemap.xml'] = { contentType: 'application/xml', body: sitemapXml(locs) };
    for (const l of locs) fx.pages[l] = HTML(`Page ${l}`, 'body text that is comfortably over twenty characters');
    return locs;
}

const ingestSitemap = (body) =>
    dispatch({ method: 'POST', url: '/kb1/ingest/sitemap', body: { url: 'https://site.example/', ...body }, session: SESSION });

test('an explicit maxPages is honoured', async () => {
    seedSitemap(60);
    const res = await ingestSitemap({ maxPages: 2 });
    assert.strictEqual(res.body.totalPages, 2);
    assert.strictEqual(res.body.maxPages, 2);
    assert.strictEqual(res.body.maxPagesCapped, false);
});

test('a non-numeric maxPages is refused — neither unbounded nor a silent default', async () => {
    // Pre-clamp, a non-numeric maxPages made every `size >= maxPages` compare
    // false, i.e. no limit at all. The clamp then read it as the 50-page
    // default, under a 200 that did not say the caller's value was ignored.
    // Now it is refused, and nothing is fetched.
    seedSitemap(60);
    const res = await ingestSitemap({ maxPages: 'all of them' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.maxPages'));
    assert.strictEqual(fx.fetched.length, 0, 'no page fetched for a refused request');
    assert.strictEqual(fx.ingested.length, 0);
});

test('an absent maxPages uses the 50-page default', async () => {
    seedSitemap(60);
    const res = await ingestSitemap({});
    assert.strictEqual(res.body.totalPages, 50);
    assert.strictEqual(res.body.maxPages, 50);
});

test('maxPages above MAX_SITEMAP_PAGES is capped at 500 and the response says so', async () => {
    // The amplifier the finding named: an unbounded maxPages turns one request
    // into an arbitrarily long walk. 520 > 500, so a cap that is not applied
    // shows up as 520 here.
    seedSitemap(520);
    const res = await ingestSitemap({ maxPages: 100000 });
    assert.strictEqual(res.body.totalPages, 500, 'clamped to MAX_SITEMAP_PAGES');
    assert.strictEqual(res.body.maxPages, 500);
    assert.strictEqual(res.body.maxPagesCapped, true, 'truncation is reported, not silent');
});

// The pre-clamp handler destructured `const { maxPages = 50 } = req.body`, so
// only a MISSING value defaulted; 0 / null / '' made `size >= maxPages` true on
// the first compare and the walk ended before it began. The first version of
// this clamp used Math.max(…, 1) and so ingested one page for all three — a
// page the caller did not ask for. Walking nothing was the honest half, but it
// answered 404 "No pages found in sitemap", which says something about the
// SITE that was never checked. These are refused now: still nothing fetched,
// nothing ingested, and the answer names the field that was wrong.
for (const [label, value] of [['0', 0], ['null', null], ["''", ''], ['a negative number', -5]]) {
    test(`maxPages of ${label} is refused and walks nothing`, async () => {
        seedSitemap(60);
        const res = await ingestSitemap({ maxPages: value });
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.details.some((d) => d.path === 'body.maxPages'));
        assert.strictEqual(fx.fetched.length, 0, 'nothing is fetched');
        assert.strictEqual(fx.ingested.length, 0, 'nothing is ingested');
    });
}

// ═══ the escape hatch: closed by default, opt-in per deployment ══════

test('a private target is refused by default — no env flag, no intranet fetch', async () => {
    resetFx();
    fx.publicHosts.add('public.example');   // 192.168.x is NOT in the allow-list
    fx.pages['http://192.168.1.10/sitemap.xml'] = { contentType: 'application/xml', body: sitemapXml(['http://192.168.1.10/wiki']) };

    const res = await dispatch({
        method: 'POST', url: '/kb1/ingest/sitemap',
        body: { url: 'http://192.168.1.10/' }, session: SESSION,
    });

    assert.strictEqual(res.statusCode, 404, 'nothing on the intranet host was reachable');
    assert.strictEqual(fx.fetched.length, 0, 'no socket opened');
    assert.strictEqual(fx.plainFetched.length, 0, 'the plain fetch is not used without the flag');
    assert.strictEqual(fx.ingested.length, 0);
});

test('KB_ALLOW_PRIVATE_HOSTS=1 lets a self-hosted install ingest its own intranet', async () => {
    resetFx();
    fx.allowPlainFetch = true;
    process.env.KB_ALLOW_PRIVATE_HOSTS = '1';
    try {
        fx.pages['http://192.168.1.10/sitemap.xml'] = {
            contentType: 'application/xml',
            body: sitemapXml(['http://192.168.1.10/wiki']),
        };
        fx.pages['http://192.168.1.10/wiki'] = HTML('Intranet wiki', 'internal handbook content, well over twenty characters');

        const res = await dispatch({
            method: 'POST', url: '/kb1/ingest/sitemap',
            body: { url: 'http://192.168.1.10/' }, session: SESSION,
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.ingested, 1);
        assert.strictEqual(fx.ingested[0].sourceUri, 'http://192.168.1.10/wiki');
        // The flag is what changed the transport — nothing went through the
        // address-screening safeFetch, which would have refused this host.
        assert.ok(fx.plainFetched.includes('http://192.168.1.10/wiki'));
        assert.strictEqual(fx.fetched.length, 0);
    } finally {
        delete process.env.KB_ALLOW_PRIVATE_HOSTS;
    }
});

test('cloud metadata endpoints stay refused even with KB_ALLOW_PRIVATE_HOSTS=1', async () => {
    resetFx();
    fx.allowPlainFetch = true;
    process.env.KB_ALLOW_PRIVATE_HOSTS = '1';
    try {
        const IMDS = 'http://169.254.169.254/latest/meta-data/';
        fx.pages['http://192.168.1.10/sitemap.xml'] = { contentType: 'application/xml', body: sitemapXml([IMDS, 'http://192.168.1.10/wiki']) };
        fx.pages['http://192.168.1.10/wiki'] = HTML('Intranet wiki', 'internal handbook content, well over twenty characters');
        fx.pages[IMDS] = { contentType: 'text/plain', body: 'iam/security-credentials/ and more secrets than twenty characters' };

        const res = await dispatch({
            method: 'POST', url: '/kb1/ingest/sitemap',
            body: { url: 'http://192.168.1.10/' }, session: SESSION,
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(!fx.plainFetched.includes(IMDS), 'the metadata endpoint is never fetched, in either mode');
        assert.ok(!fx.ingested.some(d => d.sourceUri === IMDS));
        const detail = res.body.details.find(d => d.url === IMDS);
        assert.match(detail.reason, /metadata endpoint/);
        // The legitimate intranet page still goes through.
        assert.strictEqual(res.body.ingested, 1);
    } finally {
        delete process.env.KB_ALLOW_PRIVATE_HOSTS;
    }
});

test('the escape hatch is deployment-level: a request body cannot turn it on', async () => {
    resetFx();
    fx.allowPlainFetch = true;   // would record a bypass if one happened
    fx.publicHosts.add('public.example');
    fx.pages['http://192.168.1.10/sitemap.xml'] = { contentType: 'application/xml', body: sitemapXml(['http://192.168.1.10/wiki']) };

    const res = await dispatch({
        method: 'POST', url: '/kb1/ingest/sitemap',
        body: {
            url: 'http://192.168.1.10/',
            allowPrivate: true, allowPrivateHosts: true, KB_ALLOW_PRIVATE_HOSTS: '1',
        },
        session: SESSION,
    });

    // Refused outright now (the body is `.strict()`), rather than ignored.
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(fx.fetched.length, 0, 'nothing fetched through either path');
    assert.strictEqual(fx.plainFetched.length, 0, 'no body field can select the plain-fetch path');
    assert.strictEqual(fx.ingested.length, 0);
});
