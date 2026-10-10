/**
 * Screenshot rendering for the CMS MCP server: content resolution, the document
 * and the fake network handed to the browser, the unavailable paths, and the
 * image bounds. The browser itself is a stub; nothing here needs a Chromium.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
    createScreenshotRenderer, createHubFetcher, isHubAssetPath, encodeImage, captureWithBrowser, isFakeOrigin, CONSENT_INIT_SCRIPT, FAKE_ORIGIN,
} = require('./screenshot');

const SHELL = '<!doctype html><html lang="en"><head><title>x</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';

const SITE = {
    id: 'pj_aaaa', name: 'Main',
    pages: [{ id: 'pg_1', slug: 'home', isHomepage: true }, { id: 'pg_2', slug: 'pricing', isHomepage: false }],
};

function effFor(slug) {
    const page = slug === 'pricing'
        ? { id: 'pg_2', slug: 'pricing', title: 'Pricing', blocks: [{ type: 'hero', content: { title: 'Prices' } }] }
        : { id: 'pg_1', slug: 'home', title: 'Home', isHomepage: true, blocks: [{ type: 'hero', content: { title: 'Welcome' } }] };
    return { found: true, page, header: { logoText: 'Acme' }, footer: {}, pages: [], design: {} };
}

async function bigPng(w, h) {
    return sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).png().toBuffer();
}

function makeDeps(over = {}) {
    const seen = { capture: [] };
    const cmsStore = {
        getDefaultLocale: async () => 'en',
        isValidLocale: (c) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c),
        getProject: async (id) => (id === SITE.id ? structuredClone(SITE) : null),
        getPublishedSnapshot: async () => null,
        getEffective: async (id, slug) => effFor(slug),
        getEffectivePublished: async (id, slug) => effFor(slug),
    };
    const deps = {
        cmsStore,
        getShell: async () => SHELL,
        buildHead: ({ page }) => `<title>${page.title}</title>`,
        renderBlocks: (blocks) => `<div class="cms-prehydrate">${blocks.length} blocks</div>`,
        PREHYDRATE_CSS: '.cms-prehydrate{padding:0}',
        injectIntoShell: (shell, { head, body, lang }) => shell.replace('</head>', `${head}</head>`).replace('<div id="root"></div>', `<div id="root">${body}</div>`).replace('lang="en"', `lang="${lang}"`),
        jsonForScript: (o) => JSON.stringify(o).replace(/</g, '\\u003c'),
        buildPublicPath: (locale, slug, def) => `${locale !== def ? `/${locale}` : ''}${slug ? `/${slug}` : ''}` || '/',
        synthesizeLegacyContent: (eff) => ({ title: eff.page.title }),
        fetchHubAsset: async (p) => (p === '/assets/index-abc.js' ? { body: Buffer.from('console.log(1)'), contentType: 'text/javascript' } : null),
        readCmsAsset: async (key) => (key === 'cms/1-a.png' ? { body: Buffer.from('PNG'), contentType: 'image/png' } : key === 'cms/2-v.mp4' ? { body: Buffer.from('MP4'), contentType: 'video/mp4' } : null),
        capture: async (args) => { seen.capture.push(args); return { png: await bigPng(1280, 800), hydrated: true, pageHeight: 3000 }; },
        encode: encodeImage,
        hardTimeoutMs: 2000,
        ...over,
    };
    return { deps, seen };
}

test('draft homepage: hydrated render, image bounded, text says it is the real bundle', async () => {
    const { deps, seen } = makeDeps();
    const out = await createScreenshotRenderer(deps).render({ siteId: SITE.id, state: 'draft', viewport: 'desktop' });
    assert.equal(out.ok, true);
    assert.equal(out.rendering, 'hydrated');
    assert.equal(out.image.mimeType, 'image/png');
    assert.ok(Math.max(out.image.width, out.image.height) <= 1280);
    assert.match(out.text, /real site bundle/);
    assert.match(out.text, /3000px tall/);
    assert.equal(seen.capture[0].url, `${FAKE_ORIGIN}/`);
    assert.deepEqual(seen.capture[0].viewport, { width: 1280, height: 800 });
});

test('the longest side is capped at 1280, also for a tall full-page capture', async () => {
    const { deps } = makeDeps({ capture: async () => ({ png: await bigPng(1280, 6000), hydrated: true, pageHeight: 6000 }) });
    const out = await createScreenshotRenderer(deps).render({ siteId: SITE.id, fullPage: true });
    assert.ok(out.image.height <= 1280 && out.image.width <= 1280);
    assert.match(out.text, /scaled down/);
});

test('a large flat image is re-encoded as JPEG when the PNG would be heavy', async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 1280 * 800 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 1280, height: 800, channels: 3 } }).png().toBuffer();
    const out = await encodeImage(noisy);
    assert.equal(out.mimeType, 'image/jpeg');
});

test('server-markup-only fallback is announced, with the reason', async () => {
    const hydratedFalse = makeDeps({ capture: async () => ({ png: await bigPng(800, 600), hydrated: false, pageHeight: 800 }) });
    const a = await createScreenshotRenderer(hydratedFalse.deps).render({ siteId: SITE.id });
    assert.equal(a.rendering, 'server-markup-only');
    assert.match(a.text, /server-rendered markup only/);
    assert.match(a.text, /bundle did not start/);

    const noShell = makeDeps({ getShell: async () => null, capture: async () => ({ png: await bigPng(800, 600), hydrated: false, pageHeight: 800 }) });
    const b = await createScreenshotRenderer(noShell.deps).render({ siteId: SITE.id });
    assert.match(b.text, /shell could not be fetched/);
});

test('page by slug, by id; a non-default locale is part of the path', async () => {
    const { deps, seen } = makeDeps();
    const r = createScreenshotRenderer(deps);
    await r.render({ siteId: SITE.id, slug: '/Pricing/' });
    await r.render({ siteId: SITE.id, pageId: 'pg_2', locale: 'nl', viewport: 'mobile' });
    assert.equal(seen.capture[0].url, `${FAKE_ORIGIN}/pricing`);
    assert.equal(seen.capture[1].url, `${FAKE_ORIGIN}/nl/pricing`);
    assert.deepEqual(seen.capture[1].viewport, { width: 390, height: 844 });
});

test('published state reads the snapshot; with none it says to use draft', async () => {
    const none = makeDeps();
    const out = await createScreenshotRenderer(none.deps).render({ siteId: SITE.id, state: 'published' });
    assert.equal(out.unavailable, true);
    assert.match(out.reason, /never been published/);
    assert.equal(none.seen.capture.length, 0);

    let used = null;
    const withSnap = makeDeps();
    withSnap.deps.cmsStore.getPublishedSnapshot = async () => ({ site: SITE });
    withSnap.deps.cmsStore.getEffectivePublished = async (id, slug) => { used = 'published'; return effFor(slug); };
    const ok = await createScreenshotRenderer(withSnap.deps).render({ siteId: SITE.id, state: 'published' });
    assert.equal(ok.ok, true);
    assert.equal(used, 'published');
});

test('unknown page, unknown site and bad locale are plain-sentence results', async () => {
    const { deps } = makeDeps();
    const r = createScreenshotRenderer(deps);
    const a = await r.render({ siteId: SITE.id, slug: 'nope' });
    assert.equal(a.unavailable, true);
    assert.match(a.reason, /does not exist/);
    assert.match(a.reason, /pg_2/);
    assert.match((await r.render({ siteId: 'pj_zzzz' })).reason, /not found/);
    assert.match((await r.render({ siteId: SITE.id, locale: 'not valid!' })).reason, /language code/);
});

test('no browser backend: a plain sentence, never a throw', async () => {
    const boom = Object.assign(new Error('Browser backend unavailable (ws refused). Run the sidecar...'), { code: 'browser_backend_unavailable' });
    const { deps } = makeDeps({ capture: async () => { throw boom; } });
    const out = await createScreenshotRenderer(deps).render({ siteId: SITE.id });
    assert.deepEqual(Object.keys(out).sort(), ['ok', 'reason', 'unavailable']);
    assert.equal(out.ok, false);
    assert.match(out.reason, /^no browser is available on this server/);
    assert.ok(!out.reason.includes('ws refused'), 'operator detail does not reach the model');
});

test('any other render failure, and a hung browser, are unavailable results too', async () => {
    const a = makeDeps({ capture: async () => { throw new Error('page crashed'); } });
    assert.match((await createScreenshotRenderer(a.deps).render({ siteId: SITE.id })).reason, /could not be rendered \(page crashed\)/);
    const b = makeDeps({ capture: () => new Promise(() => {}), hardTimeoutMs: 30 });
    assert.match((await createScreenshotRenderer(b.deps).render({ siteId: SITE.id })).reason, /timed out/);
    const c = makeDeps({ capture: async () => ({ png: null }) });
    assert.match((await createScreenshotRenderer(c.deps).render({ siteId: SITE.id })).reason, /did not produce/);
});

test('the document inlines the CMS payload and the server markup; no shell gives a self-contained page', async () => {
    const { deps } = makeDeps();
    const r = createScreenshotRenderer(deps);
    const content = await r.resolveContent({ siteId: SITE.id, state: 'draft' });
    const doc = await r.composeDocument(content);
    assert.equal(doc.hasShell, true);
    assert.match(doc.html, /id="__BEEFLOW_CMS__"/);
    assert.match(doc.html, /<div id="root"><div class="cms-prehydrate">1 blocks<\/div><\/div>/);
    assert.match(doc.html, /\.cms-prehydrate\{padding:0\}/);

    const bare = makeDeps({ getShell: async () => null });
    const r2 = createScreenshotRenderer(bare.deps);
    const doc2 = await r2.composeDocument(await r2.resolveContent({ siteId: SITE.id, state: 'draft' }));
    assert.equal(doc2.hasShell, false);
    assert.match(doc2.html, /^<!doctype html>/);
    assert.match(doc2.html, /<div id="root">/);
});

test('the fake network: document, content payload, hub assets, CMS images, everything else empty', async () => {
    const { deps } = makeDeps();
    const r = createScreenshotRenderer(deps);
    const content = await r.resolveContent({ siteId: SITE.id, state: 'draft' });
    const serve = r.makeServe(await r.composeDocument(content));

    assert.match((await serve('/', 'document')).body, /<div id="root">/);
    const site = JSON.parse((await serve('/api/cms/site', 'fetch')).body);
    assert.equal(site.enabled, true);
    assert.equal(site.analytics, null);
    assert.equal((await serve('/assets/index-abc.js', 'script')).status, 200);
    assert.equal((await serve('/assets/missing.js', 'script')).status, 404);
    assert.equal((await serve('/api/cms/asset/cms/1-a.png', 'image')).contentType, 'image/png');
    assert.equal((await serve('/api/cms/asset/cms/2-v.mp4', 'media')).status, 204, 'clips are not shipped to the render');
    assert.equal((await serve('/api/cms/asset/other/secret.png', 'image')).status, 404, 'only cms/ keys');
    assert.equal((await serve('/api/cms/asset/cms/..%2F..%2Fx.png', 'image')).status, 404);
    assert.equal((await serve('/api/auth/me', 'fetch')).status, 204);
});

test('the hub fetch allow-list: only built-asset paths, no traversal', () => {
    for (const ok of ['/assets/index-abc.js', '/assets/chunks/a-1.css', '/fonts/inter.woff2', '/module-shims/react.js', '/app-icon.svg']) {
        assert.equal(isHubAssetPath(ok), true, ok);
    }
    for (const bad of ['/etc/passwd', '/assets/../secret', '/assets//x', '/assets/', '/api/health', 'assets/x.js', '/assets/a b.js', '//evil.test/x']) {
        assert.equal(isHubAssetPath(bad), false, bad);
    }
});

test('the hub fetcher caches, caps size and survives failures', async () => {
    let calls = 0;
    const body = Buffer.from('ok');
    const fetchImpl = async (url) => {
        calls += 1;
        if (url.endsWith('/fail.js')) throw new Error('down');
        if (url.endsWith('/big.js')) return { ok: true, headers: new Map([['content-length', String(50 * 1024 * 1024)]]), arrayBuffer: async () => body };
        return { ok: true, headers: new Map([['content-type', 'text/javascript']]), arrayBuffer: async () => body };
    };
    const fetcher = createHubFetcher({ origin: 'http://hub', fetchImpl });
    assert.equal((await fetcher('/assets/a.js')).contentType, 'text/javascript');
    await fetcher('/assets/a.js');
    assert.equal(calls, 1, 'second read is from the cache');
    assert.equal(await fetcher('/assets/fail.js'), null);
    assert.equal(await fetcher('/assets/big.js'), null);
    assert.equal(await fetcher('/etc/passwd'), null);
    assert.equal(calls, 3, 'a disallowed path never reaches the network');
});

test('the browser context pre-declines the cookie banner before the page loads', async () => {
    const order = [];
    const png = await bigPng(1280, 800);
    const page = {
        setDefaultTimeout() {}, on() {}, route: async () => { order.push('page.route'); },
        goto: async () => { order.push('goto'); }, waitForFunction: async () => {}, evaluate: async () => 800,
        waitForTimeout: async () => {}, screenshot: async () => png,
    };
    const context = {
        addInitScript: async (script) => { order.push(`init:${script}`); },
        route: async () => {},
        routeWebSocket: async () => {},
        newPage: async () => page,
    };
    const provider = { withContext: async (opts, fn) => fn(context) };
    await captureWithBrowser({ serve: async () => ({ status: 204 }), url: `${FAKE_ORIGIN}/`, viewport: { width: 1280, height: 800 }, fullPage: false, offsetY: 0 }, provider);
    assert.equal(order.find((o) => o.startsWith('init:')), `init:${CONSENT_INIT_SCRIPT}`);
    assert.ok(order.findIndex((o) => o.startsWith('init:')) < order.indexOf('goto'), 'installed before navigation');
    // The key and value are the marketing site's own (marketing/components/consent.js).
    assert.match(CONSENT_INIT_SCRIPT, /localStorage\.setItem\('cookie_consent', 'declined'\)/);
});

test('the network filter: only the exact fake origin passes, every other request is aborted, sockets are closed', async () => {
    const png = await bigPng(1280, 800);
    const page = {
        setDefaultTimeout() {}, on() {}, route: async () => {},
        goto: async () => {}, waitForFunction: async () => {}, evaluate: async () => 800,
        waitForTimeout: async () => {}, screenshot: async () => png,
    };
    const routes = [];
    const sockets = [];
    const context = {
        addInitScript: async () => {},
        route: async (matcher, handler) => { routes.push({ matcher, handler }); },
        routeWebSocket: async (matcher, handler) => { sockets.push({ matcher, handler }); },
        newPage: async () => page,
    };
    const provider = { withContext: async (opts, fn) => fn(context) };
    await captureWithBrowser({ serve: async () => ({ status: 204 }), url: `${FAKE_ORIGIN}/`, viewport: { width: 1280, height: 800 }, fullPage: false, offsetY: 0 }, provider);

    assert.equal(routes.length, 1);
    assert.equal(routes[0].matcher, '**/*', 'every request goes through the filter');
    const verdict = (url) => {
        let result = null;
        routes[0].handler({ request: () => ({ url: () => url }), abort: () => { result = 'abort'; }, fallback: () => { result = 'fallback'; } });
        return result;
    };
    assert.equal(verdict(`${FAKE_ORIGIN}/assets/a.js`), 'fallback');
    for (const url of [
        'https://example.com/', 'http://169.254.169.254/latest/meta-data', `${FAKE_ORIGIN}.evil.example/x`,
        'https://cms-preview.beeflow.local@evil.example/', 'http://cms-preview.beeflow.local/', 'wss://example.com/socket',
        'ftp://example.com/file', 'file:///etc/passwd', 'not a url',
    ]) {
        assert.equal(verdict(url), 'abort', url);
    }

    assert.equal(sockets.length, 1);
    let closed = false;
    sockets[0].handler({ close: () => { closed = true; } });
    assert.equal(closed, true);
    assert.ok(sockets[0].matcher.test('wss://anything/'), 'the matcher covers every socket URL');
});

test('isFakeOrigin compares the parsed origin, not a string prefix', () => {
    assert.equal(isFakeOrigin(`${FAKE_ORIGIN}/a/b?c=d`), true);
    assert.equal(isFakeOrigin(`${FAKE_ORIGIN}.evil.example/`), false);
    assert.equal(isFakeOrigin(`${FAKE_ORIGIN}:8443/`), false);
    assert.equal(isFakeOrigin('garbage'), false);
});
