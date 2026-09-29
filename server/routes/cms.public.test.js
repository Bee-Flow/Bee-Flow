/**
 * Route tests for the PUBLIC CMS endpoint (GET /api/cms/site) — the
 * analytics envelope (Umami + site-level GA + per-page noAnalytics) and
 * the legacy-content nav synthesis (mega-menu dropdown mapping).
 *
 * The CMS layer (stores/cmsStore + routes/cms.js handler bodies) runs REAL
 * on an in-memory config table; the Postgres edges (configStore + db) and
 * the route's heavy siblings (umami client, translate, storage, rate
 * limiter, license, svg sanitizer) are mocked via the Module._resolveFilename
 * harness (same pattern as routes/ai/cmsBuilder.test.js). Requests go over
 * real HTTP against express app.listen(0).
 *
 * Run: node --test routes/cms.public.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── In-memory config table + db LIKE queries (real cmsStore on top) ──

const configState = { map: new Map() };

const mockConfigStore = {
    async getConfig(key) { return clone(configState.map.get(key)); },
    async getConfigFresh(key) { return clone(configState.map.get(key)); },
    async setConfig(key, value) { configState.map.set(key, clone(value)); },
    async deleteConfig(key) { configState.map.delete(key); },
    async mutateConfig(key, fn) {
        const cur = configState.map.has(key) ? clone(configState.map.get(key)) : undefined;
        const next = fn(cur);
        configState.map.set(key, clone(next));
        return next;
    },
};

function likeToRegex(pattern) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${esc.replace(/%/g, '.*').replace(/_/g, '.')}$`);
}

const mockDb = {
    async getAll(sql, params) {
        const keys = [...configState.map.keys()];
        if (/key = \$1 OR key LIKE \$2/.test(sql)) {
            const re = likeToRegex(params[1]);
            return keys.filter((k) => k === params[0] || re.test(k)).map((k) => ({ key: k }));
        }
        const re = likeToRegex(params[0]);
        return keys.filter((k) => re.test(k)).map((k) => ({ key: k }));
    },
};

const MOCKS = {
    // cmsStore's Postgres edges — the store itself runs REAL. cms.js
    // requires the same configStore module under its routes-relative path.
    './configStore': mockConfigStore,
    '../stores/configStore': mockConfigStore,
    '../db': mockDb,
    // The store's aggregates live in stores/cms/, one level deeper than the
    // cmsStore.js facade, so they spell the same two edges differently.
    '../configStore': mockConfigStore,
    '../../db': mockDb,
    // Route siblings not under test.
    '../core/cms/cmsTranslate': {},
    '../stores/languageStore': { getAvailableLocales: async () => ['en'] },
    '../stores/storageStore': {},
    '../core/umamiClient': {
        KEY_URL: 'cms_analytics_url',
        isConfigured: async () => false,
        ensureWebsite: async () => { throw new Error('not used in tests'); },
        METRIC_TYPES: ['path', 'referrer', 'browser', 'os', 'device', 'country', 'event'],
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    './cmsShared': {
        requireAdmin: (req, res, next) => next(),
        attachSiteIdFromParam: (req, res, next) => next(),
        SITE_ID_RE: /^pj_[a-f0-9]{4,}$/,
        KEY_CMS_LIVE_SITE_ID: 'cms_live_site_id',
        KEY_CMS_ENABLED: 'cms_enabled',
        // Mirrors the real helper (cmsShared.js) against the in-memory config
        // store: a stored id only counts while its project still exists.
        getLiveSiteId: async () => {
            const stored = await mockConfigStore.getConfig('cms_live_site_id');
            if (typeof stored !== 'string') return null;
            const project = await require('../stores/cmsStore').getProject(stored).catch(() => null);
            return project ? stored : null;
        },
        setLiveSiteId: async (id) => {
            await mockConfigStore.setConfig('cms_live_site_id', id);
            return id;
        },
    },
    '../utils/svgSanitizer': { sanitizeSvg: () => ({ ok: false }) },
    // Lazy-required inside the public /site handler.
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
const { synthesizeLegacyContent } = require('./cms')._test;
const cmsStore = require('../stores/cmsStore');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;
let siteId;
let pricingPageId;

async function getJson(path) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.strictEqual(res.status, 200, `GET ${path} → ${res.status}`);
    return res.json();
}

// Save the site's analytics blob + republish (the public route serves the
// published snapshot only, so every mutation must be followed by a publish).
async function setGaAndPublish(gaMeasurementId) {
    const site = await cmsStore.getProject(siteId);
    site.analytics = { gaMeasurementId };
    await cmsStore.setProject(siteId, site);
    await cmsStore.publishSite(siteId);
}

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/cms', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/cms`;

    // Seed a live site: homepage (from createProject) + a pricing page that
    // opts out of analytics, a plain nav item, and a columns mega menu.
    const created = await cmsStore.createProject({ name: 'Public site' });
    siteId = created.id;
    ({ id: pricingPageId } = await cmsStore.createPage(siteId, { slug: 'plans', title: 'Pricing' }));
    await cmsStore.updatePageMeta(siteId, pricingPageId, { noAnalytics: true });

    const site = await cmsStore.getProject(siteId);
    site.header.nav = [
        {
            id: 'nav_1',
            label: 'Docs',
            link: { kind: 'external', url: 'https://docs.example.com' },
        },
        {
            id: 'nav_2',
            label: 'Product',
            link: { kind: 'anchor', anchor: '' },
            dropdown: {
                layout: 'columns',
                columns: [{
                    heading: 'Build',
                    items: [
                        {
                            label: 'Pricing',
                            link: { kind: 'page', pageId: pricingPageId },
                            description: 'Plans & pricing',
                            icon: 'tag',
                        },
                        {
                            label: 'Blog',
                            link: { kind: 'external', url: 'https://blog.example.com' },
                            openInNewTab: true,
                        },
                    ],
                }],
            },
        },
    ];
    site.analytics = { gaMeasurementId: 'g-test1234' }; // lowercase on purpose
    await cmsStore.setProject(siteId, site);

    await mockConfigStore.setConfig('cms_live_site_id', siteId);
    await cmsStore.publishSite(siteId);
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

// ── Analytics envelope ──────────────────────────────────────────────

// Mirrored onto the public <script> tag. Asserted explicitly rather than
// spread, so a change to what the tracker is told to do has to be deliberate.
const TRACKER_DEFAULTS = {
    tag: '',
    excludeSearch: false,
    excludeHash: true,
    doNotTrack: false,
    domains: '',
};

test('GA set + Umami unset → envelope with non-null ga on both shapes', async () => {
    const legacy = await getJson('/site');
    assert.deepStrictEqual(legacy.analytics, {
        ga: { measurementId: 'G-TEST1234' },   // uppercased through the save chain
        disabledForPage: false,
    });

    const v2 = await getJson('/site?v=2');
    assert.deepStrictEqual(v2.analytics, legacy.analytics);
    assert.strictEqual(v2.page.noAnalytics, false);
});

test('page with noAnalytics → disabledForPage: true', async () => {
    const legacy = await getJson('/site?slug=plans');
    assert.deepStrictEqual(legacy.analytics, {
        ga: { measurementId: 'G-TEST1234' },
        disabledForPage: true,
    });

    const v2 = await getJson('/site?v=2&slug=plans');
    assert.strictEqual(v2.analytics.disabledForPage, true);
    assert.strictEqual(v2.page.noAnalytics, true);
});

test('Umami set + GA unset → legacy Umami keys intact, ga: null', async () => {
    await mockConfigStore.setConfig('cms_analytics_enabled', true);
    await mockConfigStore.setConfig('cms_analytics_url', 'https://stats.example.com/');
    await mockConfigStore.setConfig('cms_analytics_site_map', { [siteId]: 'web_123' });
    await setGaAndPublish('');

    const legacy = await getJson('/site');
    assert.deepStrictEqual(legacy.analytics, {
        websiteId: 'web_123',
        scriptUrl: 'https://stats.example.com/script.js',
        consentMode: 'cookieless',
        trackerOptions: TRACKER_DEFAULTS,
        ga: null,
        disabledForPage: false,
    });
});

test('Umami + GA both set → Umami keys top-level plus ga', async () => {
    await setGaAndPublish('G-BOTH5678');

    const legacy = await getJson('/site');
    assert.deepStrictEqual(legacy.analytics, {
        websiteId: 'web_123',
        scriptUrl: 'https://stats.example.com/script.js',
        consentMode: 'cookieless',
        trackerOptions: TRACKER_DEFAULTS,
        ga: { measurementId: 'G-BOTH5678' },
        disabledForPage: false,
    });
});

test('neither Umami nor GA configured → analytics: null', async () => {
    await mockConfigStore.setConfig('cms_analytics_enabled', false);
    await setGaAndPublish('');

    const legacy = await getJson('/site');
    assert.strictEqual(legacy.analytics, null);
    const v2 = await getJson('/site?v=2');
    assert.strictEqual(v2.analytics, null);
});

// ── Legacy nav synthesis (mega-menu fix) ────────────────────────────

test('published nav emits the columns dropdown with resolved hrefs (preview shape)', async () => {
    const legacy = await getJson('/site');
    const navLinks = legacy.content.header.navLinks;
    assert.strictEqual(navLinks.length, 2);

    // Plain item — byte-identical to the pre-fix output (no dropdown key).
    assert.strictEqual(
        JSON.stringify(navLinks[0]),
        JSON.stringify({ label: 'Docs', href: 'https://docs.example.com', children: [] }));

    // Mega item — mirrors buildPreviewContent's display mapping.
    assert.strictEqual(navLinks[1].label, 'Product');
    assert.deepStrictEqual(navLinks[1].dropdown, {
        layout: 'columns',
        columns: [{
            heading: 'Build',
            items: [
                {
                    label: 'Pricing',
                    href: '/plans',                    // page link resolved by resolveLinksInTree
                    description: 'Plans & pricing',
                    icon: 'tag',
                },
                {
                    label: 'Blog',
                    href: 'https://blog.example.com',
                    description: '',
                    icon: '',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
            ],
        }],
    });
});

// ── synthesizeLegacyContent unit (via the router's test seam) ───────

test('synthesizeLegacyContent: plain nav item stays byte-identical, list dropdown emits no dropdown key', () => {
    const eff = {
        found: true,
        header: {
            enabled: true,
            nav: [
                { label: 'X', link: { href: '/x' } },
                {
                    label: 'Y',
                    link: { href: '/y' },
                    children: [{ label: 'C', link: { href: '/c', target: '_blank', rel: 'noopener noreferrer' } }],
                    dropdown: { layout: 'list' },       // not columns → ignored
                },
            ],
            ctas: [],
        },
        footer: null,
        cookieBanner: null,
        page: null,
        pages: [],
        design: null,
        analytics: null,
    };
    const out = synthesizeLegacyContent(eff);
    assert.strictEqual(
        JSON.stringify(out.header.navLinks[0]),
        JSON.stringify({ label: 'X', href: '/x', children: [] }));
    assert.strictEqual('dropdown' in out.header.navLinks[1], false);
    assert.strictEqual(
        JSON.stringify(out.header.navLinks[1].children[0]),
        JSON.stringify({ label: 'C', href: '/c', target: '_blank', rel: 'noopener noreferrer' }));
});

test('synthesizeLegacyContent: columns dropdown defaults missing item fields like the preview', () => {
    const eff = {
        found: true,
        header: {
            enabled: true,
            nav: [{
                label: 'P',
                link: { href: '#' },
                dropdown: {
                    layout: 'columns',
                    columns: [{ items: [{ link: { href: '/only-href' } }] }],
                },
            }],
            ctas: [],
        },
        footer: null,
        cookieBanner: null,
        page: null,
        pages: [],
        design: null,
        analytics: null,
    };
    const out = synthesizeLegacyContent(eff);
    assert.deepStrictEqual(out.header.navLinks[0].dropdown, {
        layout: 'columns',
        columns: [{
            heading: '',
            items: [{ label: '', href: '/only-href', description: '', icon: '' }],
        }],
    });
});
