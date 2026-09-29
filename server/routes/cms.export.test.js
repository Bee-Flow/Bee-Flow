/**
 * Route tests for the site export/import endpoints.
 *
 *   GET  /api/cms/sites/:siteId/export?format=zip|json
 *   POST /api/cms/sites/import                (multipart .zip OR raw JSON)
 *
 * The interesting behaviour is at the HTTP layer rather than in the store:
 * which format is the DEFAULT (zip — a JSON-only export leaves every image
 * behind), that the legacy JSON body still imports so previously-downloaded
 * files keep working, and that a missing asset degrades to a reported gap
 * instead of a failed export.
 *
 * Same Module._resolveFilename harness as routes/cms.assets.test.js: the
 * heavy siblings are mocked, requests go over real HTTP against
 * app.listen(0). cmsStore is stubbed — cmsStore.export.test.js owns the
 * bundle semantics; this file owns the wire.
 *
 * Run: node --test routes/cms.export.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');
const JSZip = require('jszip');

// ── Fixtures the mocked store hands back ────────────────────────────

const BUNDLE = {
    _beeflow_export: true,
    version: 2,
    exportedAt: '2026-07-28T00:00:00.000Z',
    site: {
        name: 'Bee Flow',
        defaultLocale: 'en',
        locales: ['en', 'nl'],
        settings: { homepageSlug: 'home' },
        design: { logo: 'cms/1700-logo.svg' },
        analytics: { gaMeasurementId: '' },
        chrome: { header: {}, footer: {}, cookieBanner: {}, announcement: {} },
        pages: [{ slug: 'home', title: 'Home', isHomepage: true, seo: {}, blocks: [] }],
    },
};

const LOGO_SVG = '<svg viewBox="0 0 1 1"/>';
const LOGO_BYTES = Buffer.byteLength(LOGO_SVG);

const storageState = { objects: new Map() };
const mockStorageStore = {
    isAvailable: () => true,
    async listKeys() { return []; },
    async streamFile(key) {
        if (!storageState.objects.has(key)) {
            const e = new Error('missing'); e.name = 'NoSuchKey'; throw e;
        }
        const { Readable } = require('stream');
        const buf = storageState.objects.get(key);
        return { stream: Readable.from([buf]), contentType: 'image/svg+xml', contentLength: buf.length };
    },
    async headFile(key) {
        if (!storageState.objects.has(key)) { const e = new Error('missing'); e.name = 'NoSuchKey'; throw e; }
        return { contentLength: storageState.objects.get(key).length };
    },
    async uploadFile(key, buffer) { storageState.objects.set(key, buffer); return { key }; },
};

const importCalls = [];
const mockCmsStore = {
    async exportSite() { return JSON.parse(JSON.stringify(BUNDLE)); },
    async importSite(payload) {
        importCalls.push(payload);
        return { siteId: 'pj_deadbeef', name: 'Bee Flow (imported)', dropped: 0, locales: ['nl'], warnings: [] };
    },
    collectAssetKeys: null,       // filled with the real implementation below
    listProjects: async () => [],
    createProject: async () => ({ id: 'pj_aaaabbbb' }),
};

const mockCmsShared = {
    requireAdmin: (req, res, next) => {
        if (req.headers['x-test-admin'] === '1') return next();
        return res.status(403).json({ error: 'Admin access required' });
    },
    attachSiteIdFromParam: (req, res, next) => { req.siteId = req.params.siteId; next(); },
    SITE_ID_RE: /^pj_[a-f0-9]{4,}$/,
    KEY_CMS_LIVE_SITE_ID: 'cms_live_site_id',
    KEY_CMS_ENABLED: 'cms_enabled',
    getLiveSiteId: async () => null,
    setLiveSiteId: async (id) => id,
};

const MOCKS = {
    './configStore': {},
    '../stores/configStore': {},
    '../db': { getAll: async () => [] },
    // Same two edges as spelled inside stores/cms/* (one level deeper).
    '../configStore': {},
    '../../db': { getAll: async () => [] },
    '../stores/cmsStore': mockCmsStore,
    '../core/cms/cmsTranslate': {},
    '../stores/languageStore': { getAvailableLocales: async () => ['en'] },
    '../stores/storageStore': mockStorageStore,
    // The SAME module, spelled from one level deeper. core/cms/cmsExportBundle.js
    // requires '../../stores/storageStore', and a mock is keyed on the request
    // STRING, so the line above never reached it: every asset read fell through
    // to the real storage store, found nothing, and the three asset tests failed
    // while the product code was correct the whole time. The bundle module used
    // to live at core/cmsExportBundle.js — moving it into core/cms/ changed its
    // relative spelling and nothing here followed.
    '../core/umamiClient': {
        KEY_URL: 'cms_analytics_url',
        isConfigured: async () => false,
        ensureWebsite: async () => { throw new Error('not used in tests'); },
        METRIC_TYPES: [],
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    './cmsShared': mockCmsShared,
    './cmsAnalytics': {
        router: require('express').Router(),
        getAnalyticsSettings: async () => ({}),
        getAnalyticsSiteMap: async () => ({}),
        getRecorderMap: async () => ({}),
        provisionAnalyticsForSite: async () => null,
    },
    // Stand-in for the real sanitizer (exercised for real in
    // core/cmsExportBundle.test.js): accepts anything that looks like SVG,
    // rejects the rest — enough for the wire-level assertions here.
    '../utils/svgSanitizer': {
        sanitizeSvg: (buf) => (/<svg/i.test(String(buf)) ? Buffer.from(String(buf)) : null),
    },
    '../license': { serverLicenseGovernsOrgs: () => false },
    '../../stores/storageStore': mockStorageStore,
    // Same again, for the same reason: cmsExportBundle sanitises imported SVGs
    // through '../../utils/svgSanitizer'. Without this line the REAL sanitizer
    // ran, and the fixture's minimal '<svg/>' came back rejected — so the
    // import reported nothing written and the test read as a product bug.
    '../../utils/svgSanitizer': {
        sanitizeSvg: (buf) => (/<svg/i.test(String(buf)) ? Buffer.from(String(buf)) : null),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

// The route walks the bundle for asset keys via cmsStore.collectAssetKeys.
// That function is pure, so use the REAL one rather than a stub that could
// drift from it — loaded by absolute path so the '../stores/cmsStore' mock
// above doesn't intercept it. (Its own './configStore' / '../db' requires
// still hit the mocks, and collectAssetKeys touches neither.)
mockCmsStore.collectAssetKeys =
    require(require('node:path').join(__dirname, '..', 'stores', 'cmsStore.js')).collectAssetKeys;

const express = require('express');
const router = require('./cms');

let server;
let baseUrl;
const ADMIN = { 'x-test-admin': '1' };

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/cms', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/cms`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
    importCalls.length = 0;
    storageState.objects.clear();
    storageState.objects.set('cms/1700-logo.svg', Buffer.from(LOGO_SVG));
});

// ── Export ───────────────────────────────────────────────────────────

test('export defaults to .zip and carries the referenced asset bytes', async () => {
    const res = await fetch(`${baseUrl}/sites/pj_abcd1234/export`, { headers: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="site-bee-flow-\d{4}-\d{2}-\d{2}\.zip"/);

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const bundle = JSON.parse(await zip.file('site.json').async('string'));
    assert.strictEqual(bundle.version, 2);
    assert.deepStrictEqual(bundle.site.assets, [{
        key: 'cms/1700-logo.svg',
        file: 'assets/cms/1700-logo.svg',
        bytes: LOGO_BYTES,
        contentType: 'image/svg+xml',
    }]);
    assert.ok(zip.file('assets/cms/1700-logo.svg'), 'the logo bytes must be in the archive');
    assert.strictEqual(bundle.site.assetsMissing, undefined);
});

test('export?format=json returns the bundle alone, no assets', async () => {
    const res = await fetch(`${baseUrl}/sites/pj_abcd1234/export?format=json`, { headers: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('content-disposition'), /\.json"/);
    const body = await res.json();
    assert.strictEqual(body.version, 2);
    assert.strictEqual(body.site.assets, undefined);
});

test('an unreadable asset is reported, not fatal', async () => {
    storageState.objects.clear();          // the logo key now 404s
    const res = await fetch(`${baseUrl}/sites/pj_abcd1234/export`, { headers: ADMIN });
    assert.strictEqual(res.status, 200, 'a partly-wiped bucket must still export');

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const bundle = JSON.parse(await zip.file('site.json').async('string'));
    assert.deepStrictEqual(bundle.site.assets, []);
    assert.strictEqual(bundle.site.assetsMissing.length, 1);
    assert.match(bundle.site.assetsMissing[0], /cms\/1700-logo\.svg/);
});

test('an unknown format is a 400, not a silent fallback', async () => {
    const res = await fetch(`${baseUrl}/sites/pj_abcd1234/export?format=tar`, { headers: ADMIN });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /'zip' or 'json'/);
});

test('export requires admin', async () => {
    const res = await fetch(`${baseUrl}/sites/pj_abcd1234/export`);
    assert.strictEqual(res.status, 403);
});

// ── Import ───────────────────────────────────────────────────────────

async function postZip(zipBuffer, { admin = true } = {}) {
    const form = new FormData();
    form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'site.zip');
    const res = await fetch(`${baseUrl}/sites/import`, {
        method: 'POST',
        headers: admin ? ADMIN : {},
        body: form,
    });
    return { status: res.status, body: await res.json() };
}

test('importing a .zip restores the assets and then the site', async () => {
    storageState.objects.clear();
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(BUNDLE));
    zip.file('assets/cms/1700-logo.svg', '<svg/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const { status, body } = await postZip(buf);
    assert.strictEqual(status, 201);
    assert.strictEqual(body.siteId, 'pj_deadbeef');
    assert.strictEqual(body.assetsWritten, 1);
    assert.strictEqual(body.assetsReused, 0);
    assert.deepStrictEqual(body.locales, ['nl']);
    assert.ok(storageState.objects.has('cms/1700-logo.svg'),
        'the asset must land in storage under its original key');
    assert.strictEqual(importCalls.length, 1);
    assert.strictEqual(importCalls[0].version, 2);
});

test('an already-present asset key is reused, not overwritten', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(BUNDLE));
    zip.file('assets/cms/1700-logo.svg', '<svg>DIFFERENT</svg>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const { status, body } = await postZip(buf);
    assert.strictEqual(status, 201);
    assert.strictEqual(body.assetsReused, 1);
    assert.strictEqual(body.assetsWritten, 0);
    assert.match(storageState.objects.get('cms/1700-logo.svg').toString(), /viewBox/,
        'the pre-existing object must survive');
});

test('a raw JSON body still imports — pre-zip exports keep working', async () => {
    const res = await fetch(`${baseUrl}/sites/import`, {
        method: 'POST',
        headers: { ...ADMIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...BUNDLE, version: 1 }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.assetsWritten, 0);
    assert.strictEqual(importCalls[0].version, 1);
});

test('a zip whose entries are unsafe imports the site and reports the skips', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(BUNDLE));
    zip.file('assets/../../etc/passwd', 'root:x:0:0');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const { status, body } = await postZip(buf);
    assert.strictEqual(status, 201);
    assert.strictEqual(body.assetsWritten, 0);
    assert.ok(body.warnings.some(w => /ignored \(not a CMS asset\)/.test(w)));
});

test('a non-zip upload is a 400 with a readable message', async () => {
    const { status, body } = await postZip(Buffer.from('definitely not a zip'));
    assert.strictEqual(status, 400);
    assert.match(body.error, /not a valid \.zip/i);
});

test('import requires admin', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(BUNDLE));
    const { status } = await postZip(await zip.generateAsync({ type: 'nodebuffer' }), { admin: false });
    assert.strictEqual(status, 403);
    assert.strictEqual(importCalls.length, 0);
});

/**
 * A mock is keyed on the REQUEST STRING, so it silently stops applying when the
 * module it stands in for moves and its relative spelling changes. That is not
 * hypothetical: cmsExportBundle moved from core/ to core/cms/, its
 * '../stores/storageStore' became '../../stores/storageStore', and this file
 * kept mocking only the old spelling. Three tests went red, the product code was
 * correct throughout, and the failure looked exactly like a broken export.
 *
 * So: every spelling in MOCKS must be one that some file in the tree actually
 * requires. A mock nobody requires is either dead weight or — the case that
 * costs a day — the stale half of a pair where the live half is unmocked.
 */
test('every mocked module path is a spelling some file actually requires', () => {
    const { execFileSync } = require('node:child_process');
    const REPO = require('node:path').resolve(__dirname, '../..');

    const unused = [];
    for (const request of Object.keys(MOCKS)) {
        // git grep for the literal require, over the tracked tree.
        let hits = '';
        try {
            hits = execFileSync('git', ['grep', '-l', `require('${request}')`, '--', 'server/'], {
                cwd: REPO, encoding: 'utf8',
            });
        } catch (_) { hits = ''; }   // git grep exits 1 on no match
        const files = hits.split('\n').filter(Boolean).filter((f) => !f.includes('.test.'));
        if (files.length === 0) unused.push(request);
    }

    assert.deepStrictEqual(
        unused, [],
        'these mocks stand in for a spelling nothing requires. Either the module moved and the '
        + 'real spelling is now unmocked (the expensive case — the mock quietly stops applying and '
        + 'the real module runs), or the entry is dead:\n' + unused.join('\n'),
    );
});
