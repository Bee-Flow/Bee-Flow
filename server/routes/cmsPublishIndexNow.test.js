/**
 * Every CMS publish path goes through IndexNow (usecases/cmsIndexNow.mts): the
 * admin publish route (cmsSiteHandlers.postSitePublish), the CMS MCP
 * cms_publish (the store mcpCms's buildRuntime hands the MCP tools) and making
 * a site live (cmsShared.setLiveSiteId). With a key, an origin and the live
 * site, a publish reads the live sitemap BEFORE it publishes; that read is what
 * this test observes, on stubbed stores (mock.method, no module mocks).
 *
 * Run: node --test routes/cmsPublishIndexNow.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const h = require('../testUtils/routeHarness');

h.recordDb();
const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');

const LIVE = 'pj_live0001';
/** @type {Array<string>} */
const calls = [];

mock.method(configStore, 'getConfigFresh', async (/** @type {string} */ key) => (key === 'cms_live_site_id' ? LIVE : null));
mock.method(cmsStore, 'getPublishedSnapshot', async () => { calls.push('sitemap-before-or-after'); return null; });
mock.method(cmsStore, 'publishSite', async (/** @type {string} */ id) => { calls.push(`publish ${id}`); return { publishedAt: 'now' }; });
mock.method(cmsStore, 'getProject', async () => null);
mock.method(configStore, 'setConfig', async (/** @type {string} */ key, /** @type {unknown} */ value) => { calls.push(`set ${key} ${value}`); });

const handlers = require('./cmsSiteHandlers');
const { mcpCmsStore, buildRuntime } = require('./mcpCms');
const cmsShared = require('./cmsShared');

/** @param {() => Promise<unknown>} run */
async function withIndexNowOn(run) {
    const saved = { key: process.env.INDEXNOW_KEY, site: process.env.PUBLIC_SITE_URL };
    process.env.INDEXNOW_KEY = 'abcdef0123456789';
    process.env.PUBLIC_SITE_URL = 'https://site.test';
    calls.length = 0;
    try {
        await run();
    } finally {
        if (saved.key === undefined) delete process.env.INDEXNOW_KEY; else process.env.INDEXNOW_KEY = saved.key;
        if (saved.site === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = saved.site;
    }
}

test('the admin publish route reads the sitemap for IndexNow before it publishes', async () => {
    await withIndexNowOn(async () => {
        const res = { statusCode: 200, body: undefined, json(/** @type {any} */ b) { this.body = b; return this; } };
        await handlers.postSitePublish(/** @type {any} */ ({ siteId: LIVE, get: () => 'site.test' }), /** @type {any} */ (res));
        assert.deepStrictEqual(calls.slice(0, 2), ['sitemap-before-or-after', `publish ${LIVE}`]);
        assert.strictEqual(/** @type {any} */ (res.body).success, true);
    });
});

test('the CMS MCP store (cms_publish) reads the sitemap for IndexNow before it publishes', async () => {
    await withIndexNowOn(async () => {
        const out = await mcpCmsStore(cmsStore).publishSite(LIVE);
        assert.deepStrictEqual(calls.slice(0, 2), ['sitemap-before-or-after', `publish ${LIVE}`]);
        assert.deepStrictEqual(out, { publishedAt: 'now' });
    });
});

test('without a key both paths only publish', async () => {
    calls.length = 0;
    delete process.env.INDEXNOW_KEY;
    await mcpCmsStore(cmsStore).publishSite(LIVE);
    assert.deepStrictEqual(calls, [`publish ${LIVE}`]);
});

test('the CMS MCP server is built on the IndexNow store: cms_publish reads the sitemap before it publishes', async (t) => {
    const cmsMcp = require('../cms/mcp');
    /** @type {any} */
    let deps = null;
    t.mock.method(cmsMcp, 'createCmsMcp', (/** @type {any} */ d) => { deps = d; return {}; });
    t.mock.method(cmsMcp, 'createUploadTickets', () => ({}));
    t.mock.method(cmsMcp, 'createScreenshotRenderer', () => ({}));
    t.mock.method(cmsMcp, 'createUploadReceiver', () => ({}));
    t.mock.method(cmsMcp, 'createAccessCheck', () => () => true);
    buildRuntime();
    assert.ok(deps, 'buildRuntime hands its collaborators to createCmsMcp');
    await withIndexNowOn(async () => {
        await deps.cmsStore.publishSite(LIVE);
        assert.deepStrictEqual(calls.slice(0, 2), ['sitemap-before-or-after', `publish ${LIVE}`]);
    });
});

test('making another site live reads the old live sitemap before it switches (IndexNow on)', async (t) => {
    t.mock.method(cmsStore, 'getProject', async () => ({ id: 'pj_beef0001' }));
    await withIndexNowOn(async () => {
        assert.strictEqual(await cmsShared.setLiveSiteId('pj_beef0001'), 'pj_beef0001');
        assert.deepStrictEqual(calls.slice(0, 2), ['sitemap-before-or-after', 'set cms_live_site_id pj_beef0001']);
    });
});

test('without a key, making a site live only switches', async (t) => {
    t.mock.method(cmsStore, 'getProject', async () => ({ id: 'pj_beef0001' }));
    calls.length = 0;
    delete process.env.INDEXNOW_KEY;
    await cmsShared.setLiveSiteId('pj_beef0001');
    assert.deepStrictEqual(calls, ['set cms_live_site_id pj_beef0001']);
});
