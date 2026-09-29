/**
 * Store tests for the site-level Google Analytics field (site.analytics)
 * and the per-page noAnalytics flag.
 *
 * The cmsStore logic runs REAL on an in-memory config table — its Postgres
 * edges (./configStore + ../db) are mocked via the Module._resolveFilename
 * harness (same pattern as routes/ai/cmsBuilder.test.js). Loading the real
 * configStore would keep the event loop alive with Postgres retries and
 * hang the process after the tests pass — always use the mock.
 *
 * Run: node --test stores/cmsStore.analytics.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
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

// Keys are the require strings AS WRITTEN in the module doing the require:
// the store's aggregates live in stores/cms/, one level deeper than the
// cmsStore.js facade, so both spellings of each edge have to be stubbed.
const MOCKS = {
    './configStore': mockConfigStore,
    '../db': mockDb,
    '../configStore': mockConfigStore,
    '../../db': mockDb,
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

const cmsStore = require('./cmsStore');
const { SITE_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

// ── sanitizeAnalytics unit ──────────────────────────────────────────

test('sanitizeAnalytics: valid id passes, lowercase is uppercased, junk is blanked', () => {
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: 'G-ABC12345' }),
        { gaMeasurementId: 'G-ABC12345' });
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: '  g-abc12345 ' }),
        { gaMeasurementId: 'G-ABC12345' });
    // Not a GA4 measurement id → blanked.
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: 'UA-123456-7' }),
        { gaMeasurementId: '' });
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: 'G-AB' }),           // too short
        { gaMeasurementId: '' });
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: 'G-' + 'A'.repeat(21) }), // too long
        { gaMeasurementId: '' });
    assert.deepStrictEqual(
        cmsStore.sanitizeAnalytics({ gaMeasurementId: 42 }),
        { gaMeasurementId: '' });
    // Non-object → full default shape.
    assert.deepStrictEqual(cmsStore.sanitizeAnalytics(null), SITE_DEFAULTS.analytics);
    assert.deepStrictEqual(cmsStore.sanitizeAnalytics('G-ABC12345'), SITE_DEFAULTS.analytics);
});

// ── sanitizePageIndexEntry unit ─────────────────────────────────────

test('sanitizePageIndexEntry: noAnalytics round-trips like hideHeader', () => {
    const entry = {
        id: 'pg_1', slug: 'pricing', title: 'Pricing',
        isHomepage: false, hideHeader: true, hideFooter: false,
        noAnalytics: true, isNotFound: false,
    };
    const once = cmsStore.sanitizePageIndexEntry(entry);
    assert.strictEqual(once.noAnalytics, true);
    assert.strictEqual(once.hideHeader, true);
    // Round-trip: sanitizing its own output is a fixpoint.
    assert.deepStrictEqual(cmsStore.sanitizePageIndexEntry(once), once);
    // Missing / truthy-coerced values behave like the sibling flags.
    assert.strictEqual(cmsStore.sanitizePageIndexEntry({ id: 'pg_2' }).noAnalytics, false);
    assert.strictEqual(cmsStore.sanitizePageIndexEntry({ id: 'pg_3', noAnalytics: 1 }).noAnalytics, true);
});

// ── Store round-trips (real setProject/getProject on the mock table) ─

test('site analytics persistence + per-page noAnalytics', async (t) => {
    const { id: siteId } = await cmsStore.createProject({ name: 'Analytics site' });

    await t.test('a fresh site carries the analytics default', async () => {
        const site = await cmsStore.getProject(siteId);
        assert.deepStrictEqual(site.analytics, { gaMeasurementId: '' });
    });

    await t.test('setProject keeps a valid gaMeasurementId and uppercases lowercase input', async () => {
        const site = await cmsStore.getProject(siteId);
        site.analytics = { gaMeasurementId: 'g-test1234' };
        const saved = await cmsStore.setProject(siteId, site);
        assert.strictEqual(saved.analytics.gaMeasurementId, 'G-TEST1234');
        const reread = await cmsStore.getProject(siteId);
        assert.strictEqual(reread.analytics.gaMeasurementId, 'G-TEST1234');
    });

    await t.test('an unrelated mutation does not erase analytics', async () => {
        await cmsStore.renameProject(siteId, 'Renamed site');
        let site = await cmsStore.getProject(siteId);
        assert.strictEqual(site.analytics.gaMeasurementId, 'G-TEST1234');

        const pageId = site.pages[0].id;
        await cmsStore.updatePageMeta(siteId, pageId, { title: 'Homepage' });
        site = await cmsStore.getProject(siteId);
        assert.strictEqual(site.analytics.gaMeasurementId, 'G-TEST1234');
        assert.strictEqual(site.pages[0].title, 'Homepage');
    });

    await t.test('updatePageMeta accepts noAnalytics and ignores unknown keys', async () => {
        const site = await cmsStore.getProject(siteId);
        const pageId = site.pages[0].id;
        const entry = await cmsStore.updatePageMeta(siteId, pageId, {
            noAnalytics: true,
            bogusKey: 'nope',
            noAnalyticsButString: 'true',
        });
        assert.strictEqual(entry.noAnalytics, true);
        const reread = await cmsStore.getProject(siteId);
        assert.strictEqual(reread.pages[0].noAnalytics, true);
        assert.strictEqual('bogusKey' in reread.pages[0], false);
        assert.strictEqual('noAnalyticsButString' in reread.pages[0], false);
        // Non-boolean noAnalytics patch is ignored (same as hideHeader).
        await cmsStore.updatePageMeta(siteId, pageId, { noAnalytics: 'false' });
        const again = await cmsStore.getProject(siteId);
        assert.strictEqual(again.pages[0].noAnalytics, true);
    });

    await t.test('getEffective carries analytics and page.noAnalytics', async () => {
        const eff = await cmsStore.getEffective(siteId, null, 'en');
        assert.strictEqual(eff.found, true);
        assert.deepStrictEqual(eff.analytics, { gaMeasurementId: 'G-TEST1234' });
        assert.strictEqual(eff.page.noAnalytics, true);
    });

    await t.test('getEffectivePublished carries analytics and page.noAnalytics through the snapshot', async () => {
        await cmsStore.publishSite(siteId);
        const eff = await cmsStore.getEffectivePublished(siteId, null, 'en');
        assert.ok(eff, 'expected a published snapshot');
        assert.strictEqual(eff.found, true);
        assert.deepStrictEqual(eff.analytics, { gaMeasurementId: 'G-TEST1234' });
        assert.strictEqual(eff.page.noAnalytics, true);
    });

    await t.test('duplicateProject copies analytics', async () => {
        const dup = await cmsStore.duplicateProject(siteId);
        const copy = await cmsStore.getProject(dup.id);
        assert.deepStrictEqual(copy.analytics, { gaMeasurementId: 'G-TEST1234' });
        // The per-page flag rides along on the copied page index too.
        assert.strictEqual(copy.pages[0].noAnalytics, true);
    });

    await t.test('export/import round-trips analytics and per-page noAnalytics', async () => {
        const exported = await cmsStore.exportSite(siteId);
        assert.deepStrictEqual(exported.site.analytics, { gaMeasurementId: 'G-TEST1234' });
        assert.strictEqual(exported.site.pages[0].noAnalytics, true);

        const imported = await cmsStore.importSite(exported);
        const restored = await cmsStore.getProject(imported.siteId);
        assert.deepStrictEqual(restored.analytics, { gaMeasurementId: 'G-TEST1234' });
        assert.strictEqual(restored.pages[0].noAnalytics, true);
    });

    await t.test('setProject blanks an invalid id and defaults when absent', async () => {
        const site = await cmsStore.getProject(siteId);
        site.analytics = { gaMeasurementId: 'not-a-ga-id' };
        const saved = await cmsStore.setProject(siteId, site);
        assert.deepStrictEqual(saved.analytics, { gaMeasurementId: '' });

        delete site.analytics;
        const saved2 = await cmsStore.setProject(siteId, site);
        assert.deepStrictEqual(saved2.analytics, { gaMeasurementId: '' });
        // Sites that never set analytics resolve to null in the effective
        // payload only when the stored doc predates the field entirely —
        // a doc written through setProject always carries the default.
        const reread = await cmsStore.getProject(siteId);
        assert.deepStrictEqual(reread.analytics, { gaMeasurementId: '' });
    });
});
