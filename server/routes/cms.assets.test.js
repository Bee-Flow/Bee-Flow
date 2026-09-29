/**
 * Route tests for GET /api/cms/admin/assets — the read-only asset
 * library behind the admin asset-reuse picker (WS3-P6).
 *
 * Covers: admin gating (requireAdmin sits in front of /admin/*), the
 * response shape (image/video filtering, newest-first order via the
 * cms/<Date.now()>- key prefix, /api/cms/asset URL building, the 500
 * cap) and the local-fs degradation path (storageStore.listKeys throws
 * → { assets: [], unavailable: true }).
 *
 * Same Module._resolveFilename mock harness as routes/cms.public.test.js
 * (the heavy route siblings are mocked; requests go over real HTTP
 * against express app.listen(0)). No Postgres needed: this route never
 * touches cmsStore/configStore, but cms.js requires them at module
 * scope, so they're stubbed the same way.
 *
 * Run: node --test routes/cms.assets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Controllable storage mock ───────────────────────────────────────

const storageState = {
    keys: [],           // what listKeys resolves with
    throwError: null,   // when set, listKeys throws (local-fs mode)
    lastPrefix: null,
};

const mockStorageStore = {
    isAvailable: () => true,
    async listKeys(prefix) {
        storageState.lastPrefix = prefix;
        if (storageState.throwError) throw storageState.throwError;
        return [...storageState.keys];
    },
};

// ── Admin gate mock — header-controlled so the test can assert the
// route actually sits behind requireAdmin (mirror of the real gate's
// 403 contract, not its session logic). ─────────────────────────────

const mockCmsShared = {
    requireAdmin: (req, res, next) => {
        if (req.headers['x-test-admin'] === '1') return next();
        return res.status(403).json({ error: 'Admin access required' });
    },
    attachSiteIdFromParam: (req, res, next) => next(),
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
    '../stores/cmsStore': {
        // attachSiteId (mounted after /admin/assets) resolves the default
        // project — the assets route must respond WITHOUT ever calling
        // this. Throwing here proves the route is registered before the
        // auto-provisioning middleware.
        listProjects: async () => { throw new Error('assets route must not touch cmsStore'); },
        createProject: async () => { throw new Error('assets route must not touch cmsStore'); },
    },
    '../core/cms/cmsTranslate': {},
    '../stores/languageStore': { getAvailableLocales: async () => ['en'] },
    '../stores/storageStore': mockStorageStore,
    '../core/umamiClient': {
        KEY_URL: 'cms_analytics_url',
        isConfigured: async () => false,
        ensureWebsite: async () => { throw new Error('not used in tests'); },
        METRIC_TYPES: ['path', 'referrer', 'browser', 'os', 'device', 'country', 'event'],
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
    '../utils/svgSanitizer': { sanitizeSvg: () => null },
    '../license': { serverLicenseGovernsOrgs: () => false },
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

const express = require('express');
const router = require('./cms');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

async function getAssets({ admin = true } = {}) {
    const res = await fetch(`${baseUrl}/admin/assets`, {
        headers: admin ? { 'x-test-admin': '1' } : {},
    });
    return { status: res.status, body: await res.json() };
}

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
    storageState.keys = [];
    storageState.throwError = null;
    storageState.lastPrefix = null;
});

// ── Gating ──────────────────────────────────────────────────────────

test('without admin → 403, storage never touched', async () => {
    storageState.keys = ['cms/1712000000000-a.png'];
    const { status } = await getAssets({ admin: false });
    assert.strictEqual(status, 403);
    assert.strictEqual(storageState.lastPrefix, null);
});

// ── Shape ───────────────────────────────────────────────────────────

test('lists cms/ keys as {key, url}, image/video only, newest-first', async () => {
    storageState.keys = [
        'cms/1712000000001-old-logo.png',
        'cms/1712000000200-notes.txt',            // filtered: not media
        'cms/1712000000300-demo.mp4',
        'cms/1712000000100-photo.JPG',            // case-insensitive ext
        'cms/1712000000400-hero.webp',
    ];
    const { status, body } = await getAssets();
    assert.strictEqual(status, 200);
    assert.strictEqual(storageState.lastPrefix, 'cms/');
    assert.strictEqual(body.unavailable, undefined);
    assert.deepStrictEqual(body.assets, [
        { key: 'cms/1712000000400-hero.webp', url: '/api/cms/asset/cms/1712000000400-hero.webp' },
        { key: 'cms/1712000000300-demo.mp4',  url: '/api/cms/asset/cms/1712000000300-demo.mp4' },
        { key: 'cms/1712000000100-photo.JPG', url: '/api/cms/asset/cms/1712000000100-photo.JPG' },
        { key: 'cms/1712000000001-old-logo.png', url: '/api/cms/asset/cms/1712000000001-old-logo.png' },
    ]);
});

test('URL segments are encoded', async () => {
    storageState.keys = ['cms/1712000000000-a b#c.png'];
    const { body } = await getAssets();
    assert.deepStrictEqual(body.assets, [{
        key: 'cms/1712000000000-a b#c.png',
        url: '/api/cms/asset/cms/1712000000000-a%20b%23c.png',
    }]);
});

test('caps the listing at 500 newest assets', async () => {
    storageState.keys = Array.from({ length: 620 }, (_, i) =>
        `cms/${1712000000000 + i}-img.png`);
    const { body } = await getAssets();
    assert.strictEqual(body.assets.length, 500);
    // Newest survives the cap; the oldest 120 are dropped.
    assert.strictEqual(body.assets[0].key, 'cms/1712000000619-img.png');
    assert.strictEqual(body.assets[499].key, 'cms/1712000000120-img.png');
});

// ── Degradation ─────────────────────────────────────────────────────

test('local-fs mode (listKeys throws) → { assets: [], unavailable: true }', async () => {
    storageState.throwError = new Error('StorageStore not initialized');
    const { status, body } = await getAssets();
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { assets: [], unavailable: true });
});
