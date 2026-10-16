/**
 * Unit tests for the CMS site-level handlers (routes/cmsSiteHandlers.js):
 * the Live toggle, the legacy org-wide `enabled` flag, the default locale,
 * site locale overrides and AI translation of the site chrome.
 *
 * The handlers are called directly with a fake req/res. Their dependencies
 * are stubbed with mock.method on the module objects the product already
 * shares (cmsStore, configStore, languageStore, cmsTranslate), never through
 * the module system (count-ratchet.mjs module-mock); testUtils/routeHarness
 * records the db pool so a query nobody stubbed can never reach Postgres.
 * cmsShared's live-site helpers run REAL on top of the stubbed config store.
 * The HTTP wiring (schemas, limiters, mount order) is covered by
 * routes/cms.validation.test.js.
 *
 * Run: node --test routes/cmsSiteHandlers.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const h = require('../testUtils/routeHarness');

const db = h.recordDb();
const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const cmsTranslate = require('../core/cms/cmsTranslate');

const calls = [];
const state = { config: {}, projects: [{ id: 'pj_aaaa1111' }, { id: 'pj_bbbb2222' }] };

mock.method(configStore, 'getConfig', async (key) => state.config[key]);
mock.method(configStore, 'setConfig', async (key, value) => { calls.push(['setConfig', key, value]); state.config[key] = value; });
mock.method(cmsStore, 'getDefaultLocale', async () => 'en');
mock.method(cmsStore, 'getProject', async (id) => state.projects.find((p) => p.id === id) || null);
mock.method(cmsStore, 'listProjects', async () => state.projects);
mock.method(cmsStore, 'getPublishedSnapshot', async () => null);
mock.method(cmsStore, 'publishSite', async (id) => { calls.push(['publishSite', id]); });
mock.method(cmsStore, 'getSiteLocaleOverride', async () => ({ kept: 'manual' }));
mock.method(cmsStore, 'setSiteLocaleOverride', async (...args) => { calls.push(['setSiteLocaleOverride', ...args]); });
mock.method(cmsStore, 'saveTranslatedSiteOverride', async (...args) => { calls.push(['saveTranslatedSiteOverride', ...args]); return args[2]; });
mock.method(cmsStore, 'deleteSiteLocaleOverride', async (...args) => { calls.push(['deleteSiteLocaleOverride', ...args]); });
mock.method(cmsStore, 'updateSiteChrome', async (...args) => { calls.push(['updateSiteChrome', ...args]); return { id: args[0], rev: 5 }; });
mock.method(cmsStore, 'setDefaultLocale', async (code) => { calls.push(['setDefaultLocale', code]); });
mock.method(languageStore, 'getAvailableLocales', async () => [{ code: 'nl', name: 'Nederlands' }]);
mock.method(cmsTranslate, 'aiTranslateSite', async (args) => {
    calls.push(['aiTranslateSite', args]);
    return { override: { header: 'Kop' }, translated: 3, total: 4, errors: 1 };
});

const handlers = require('./cmsSiteHandlers');

function fakeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

async function call(handler, req) {
    const res = fakeRes();
    await handler({ params: {}, body: {}, ...req }, res);
    return res;
}

const LIVE = 'cms_live_site_id';

test.beforeEach(() => {
    calls.length = 0;
    state.config = {};
});

// Loading the stores starts their boot-time ladders (config load, org
// backfills) against the recorded pool; let them settle, then only what
// the handlers add counts.
let queriesAtLoad = 0;
test.before(async () => {
    await db.settle();
    queriesAtLoad = db.queries.length;
});
test.after(() => {
    assert.deepStrictEqual(db.queries.slice(queriesAtLoad), [], 'every store call was stubbed');
});

test('putSiteLive: going live publishes first, then takes the site live', async () => {
    const res = await call(handlers.putSiteLive, { siteId: 'pj_aaaa1111', body: { live: true } });
    assert.deepStrictEqual(res.body, { success: true, liveSiteId: 'pj_aaaa1111' });
    assert.deepStrictEqual(calls, [['publishSite', 'pj_aaaa1111'], ['setConfig', LIVE, 'pj_aaaa1111']]);
});

test('putSiteLive: a failed publish refuses going live and keeps the old live site', async () => {
    state.config[LIVE] = 'pj_bbbb2222';
    cmsStore.publishSite.mock.mockImplementationOnce(async () => { throw new Error('s3 connect ETIMEDOUT bucket/key'); });
    const res = await call(handlers.putSiteLive, { siteId: 'pj_aaaa1111', body: { live: true } });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'cms_publish_failed');
    assert.doesNotMatch(JSON.stringify(res.body), /s3|bucket|ETIMEDOUT/);
    assert.strictEqual(state.config[LIVE], 'pj_bbbb2222');
    assert.deepStrictEqual(calls, []);
});

test('putSiteLive: a publish that never returns is cut off and the old live site stays', async () => {
    state.config[LIVE] = 'pj_bbbb2222';
    cmsStore.publishSite.mock.mockImplementationOnce(() => new Promise(() => {}));
    await assert.rejects(
        require('./cmsShared').ensurePublishedSnapshot('pj_aaaa1111', { timeoutMs: 20 }),
        (e) => e.status === 502 && e.code === 'cms_publish_failed',
    );
    assert.strictEqual(state.config[LIVE], 'pj_bbbb2222');
});

test('ensurePublishedSnapshot: a malformed siteId is a 400, not a publish failure', async () => {
    await assert.rejects(
        require('./cmsShared').ensurePublishedSnapshot('not-a-site'),
        (e) => e.status === 400 && e.code === 'cms_invalid_site_id',
    );
    assert.deepStrictEqual(calls, []);
});

test('putEnabled with a siteId publishes before switching and keeps the old site on failure', async () => {
    state.config[LIVE] = 'pj_bbbb2222';
    cmsStore.publishSite.mock.mockImplementationOnce(async () => { throw new Error('boom'); });
    await assert.rejects(call(handlers.putEnabled, { body: { enabled: true, siteId: 'pj_aaaa1111' } }), (e) => e.status === 502);
    assert.strictEqual(state.config[LIVE], 'pj_bbbb2222');
});

test('putSiteLive: switching off a site that is not live leaves the live site alone', async () => {
    state.config[LIVE] = 'pj_bbbb2222';
    const res = await call(handlers.putSiteLive, { siteId: 'pj_aaaa1111', body: { live: false } });
    assert.deepStrictEqual(res.body, { success: true, liveSiteId: 'pj_bbbb2222' });
    assert.deepStrictEqual(calls, []);
});

test('putSiteLive: switching off the live site takes the public site dark', async () => {
    state.config[LIVE] = 'pj_aaaa1111';
    const res = await call(handlers.putSiteLive, { siteId: 'pj_aaaa1111', body: { live: false } });
    assert.deepStrictEqual(res.body, { success: true, liveSiteId: null });
    assert.deepStrictEqual(calls, [['setConfig', LIVE, null]]);
});

test('putSiteLive: a non-boolean is a 400', async () => {
    const res = await call(handlers.putSiteLive, { siteId: 'pj_aaaa1111', body: { live: 'true' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'live must be a boolean' });
});

test('putEnabled: on without a siteId falls back to the first project and snapshots it', async () => {
    const res = await call(handlers.putEnabled, { body: { enabled: true } });
    assert.deepStrictEqual(res.body, { success: true, enabled: true, liveSiteId: 'pj_aaaa1111' });
    assert.deepStrictEqual(calls, [['publishSite', 'pj_aaaa1111'], ['setConfig', LIVE, 'pj_aaaa1111']]);
});

test('putEnabled: off clears the live site', async () => {
    state.config[LIVE] = 'pj_bbbb2222';
    const res = await call(handlers.putEnabled, { body: { enabled: false } });
    assert.deepStrictEqual(res.body, { success: true, enabled: false, liveSiteId: null });
    assert.deepStrictEqual(calls, [['setConfig', LIVE, null]]);
});

test('putDefaultLocale: trimmed and lowercased; a non-tag is a 400 that writes nothing', async () => {
    const ok = await call(handlers.putDefaultLocale, { body: { locale: ' PT-BR ' } });
    assert.deepStrictEqual(ok.body, { success: true, defaultLocale: 'pt-br' });
    const bad = await call(handlers.putDefaultLocale, { body: { locale: 'not a tag' } });
    assert.strictEqual(bad.statusCode, 400);
    assert.deepStrictEqual(calls, [['setDefaultLocale', 'pt-br']]);
});

test('deleteSiteLocale lowercases the locale from the URL', async () => {
    await call(handlers.deleteSiteLocale, { siteId: 'pj_aaaa1111', params: { locale: 'NL' } });
    assert.deepStrictEqual(calls, [['deleteSiteLocaleOverride', 'pj_aaaa1111', 'nl']]);
});

test('postSiteAiTranslate refuses the default locale', async () => {
    const res = await call(handlers.postSiteAiTranslate, { siteId: 'pj_aaaa1111', params: { locale: 'en' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'Cannot translate the default locale' });
});

test('postSiteAiTranslate translates with the language name and persists the override', async () => {
    const res = await call(handlers.postSiteAiTranslate, {
        siteId: 'pj_aaaa1111',
        params: { locale: 'NL' },
        body: { modelTier: 'fast' },
        session: { user: { id: 'u1', organizationId: 'o1' } },
    });
    assert.strictEqual(res.body.message, 'Translated 3 fields with 1 batch error(s)');
    const [, args] = calls.find(([name]) => name === 'aiTranslateSite');
    assert.strictEqual(args.languageName, 'Nederlands');
    assert.deepStrictEqual(args.existingOverride, { kept: 'manual' });
    assert.strictEqual(args.userId, 'u1');
    assert.strictEqual(args.userOrgId, 'o1');
    assert.deepStrictEqual(calls.at(-1), ['saveTranslatedSiteOverride', 'pj_aaaa1111', 'nl', { header: 'Kop' }, { id: 'pj_aaaa1111' }]);
    assert.deepStrictEqual(res.body.override, { header: 'Kop' });
});

test('localeName falls back to the code for an unknown locale', async () => {
    assert.strictEqual(await handlers.localeName('nl'), 'Nederlands');
    assert.strictEqual(await handlers.localeName('xx'), 'xx');
});

test('putSiteDoc: a footer whose columns is a string is refused, nothing is saved (#231)', async () => {
    await assert.rejects(
        call(handlers.putSiteDoc, { siteId: 'pj_aaaa1111', body: { site: { footer: { columns: 'x' } } } }),
        (e) => e.status === 400 && e.code === 'invalid_site_chrome' && /footer\.columns must be a list/.test(e.message),
    );
    assert.deepStrictEqual(calls, []);
});

test('putSiteDoc: a sound site is saved', async () => {
    const res = await call(handlers.putSiteDoc, { siteId: 'pj_aaaa1111', body: { site: { footer: { columns: [] } } } });
    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['updateSiteChrome']);
});

test('putSiteDoc saves the chrome against the revision the editor was based on', async () => {
    const res = await call(handlers.putSiteDoc, { siteId: 'pj_aaaa1111', body: { site: { name: 'N', rev: 4, pages: [] } } });
    assert.deepStrictEqual(res.body, { success: true, site: { id: 'pj_aaaa1111', rev: 5 }, localeOverrides: undefined });
    assert.deepStrictEqual(calls, [['updateSiteChrome', 'pj_aaaa1111', { name: 'N', rev: 4, pages: [] }, { expectedRev: 4, report: {} }]]);
});

test('putSiteDoc without a revision still saves (soft path for one release), unchecked', async () => {
    await call(handlers.putSiteDoc, { siteId: 'pj_aaaa1111', body: { site: { name: 'N' } } });
    assert.deepStrictEqual(calls, [['updateSiteChrome', 'pj_aaaa1111', { name: 'N' }, { expectedRev: undefined, report: {} }]]);
});
