/**
 * Unit tests for the CMS page handlers (routes/cmsPageHandlers.js): the
 * PageDoc write, page order, page templates and AI translation of a page.
 *
 * The handlers are called directly with a fake req/res. Their dependencies
 * are stubbed with mock.method on the module objects the product already
 * shares (cmsStore, languageStore, cmsTranslate), never through the module
 * system (count-ratchet.mjs module-mock); testUtils/routeHarness records the
 * db pool so a query nobody stubbed can never reach Postgres. The HTTP wiring
 * (schemas, limiters, mount order) is covered by routes/cms.validation.test.js.
 *
 * Run: node --test routes/cmsPageHandlers.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const h = require('../testUtils/routeHarness');

const db = h.recordDb();
const cmsStore = require('../stores/cmsStore');
const languageStore = require('../stores/languageStore');
const cmsTranslate = require('../core/cms/cmsTranslate');

const calls = [];
const state = { page: { id: 'pg1', blocks: [] } };

mock.method(cmsStore, 'getDefaultLocale', async () => 'en');
mock.method(cmsStore, 'getPage', async (siteId, id) => (id === state.page?.id ? state.page : null));
mock.method(cmsStore, 'getPageLocaleOverride', async () => null);
mock.method(cmsStore, 'saveTranslatedPageOverride', async (...args) => { calls.push(['saveTranslatedPageOverride', ...args]); return args[3]; });
mock.method(cmsStore, 'setPageLocaleOverride', async (...args) => { calls.push(['setPageLocaleOverride', ...args]); });
mock.method(cmsStore, 'setPage', async (siteId, page) => { calls.push(['setPage', siteId, page]); return { page, dropped: 2 }; });
mock.method(cmsStore, 'removePage', async (siteId, id) => (id === 'pg1'
    ? { removed: { id, slug: 'x' }, newHomepage: null, neutralisedLinks: 3 } : null));
mock.method(cmsStore, 'reorderPages', async (...args) => { calls.push(['reorderPages', ...args]); });
mock.method(cmsStore, 'getTemplates', async () => [
    { id: 't1', name: 'Hero', createdAt: '2026-01-01', blocks: [{}, {}] },
    { id: 't2', name: 'Empty', description: 'none', createdAt: '2026-01-02' },
]);
mock.method(languageStore, 'getAvailableLocales', async () => [{ code: 'de', name: 'Deutsch' }]);
mock.method(cmsTranslate, 'aiTranslatePage', async (args) => {
    calls.push(['aiTranslatePage', args]);
    return { override: { blocks: {} }, translated: 2, total: 2, errors: 0 };
});

const handlers = require('./cmsPageHandlers');

function fakeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

async function call(handler, req) {
    const res = fakeRes();
    await handler({ params: {}, body: {}, siteId: 'pj_aaaa1111', ...req }, res);
    return res;
}

test.beforeEach(() => { calls.length = 0; });

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

test('putPage writes to the page in the URL, whatever id the body carries, and reports dropped blocks', async () => {
    const res = await call(handlers.putPage, { params: { id: 'pg1' }, body: { page: { id: 'pg-other', title: 'T' } } });
    assert.deepStrictEqual(calls, [['setPage', 'pj_aaaa1111', { id: 'pg1', title: 'T' }]]);
    assert.strictEqual(res.body.dropped, 2);
    assert.strictEqual(res.body.page.id, 'pg1');
});

test('putPage without a page object is a 400', async () => {
    const res = await call(handlers.putPage, { params: { id: 'pg1' }, body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'page object required' });
});

test('putPagesOrder needs an array', async () => {
    const bad = await call(handlers.putPagesOrder, { body: { orderedIds: 'pg1' } });
    assert.strictEqual(bad.statusCode, 400);
    const ok = await call(handlers.putPagesOrder, { body: { orderedIds: ['pg1'] } });
    assert.deepStrictEqual(ok.body, { success: true });
    assert.deepStrictEqual(calls, [['reorderPages', 'pj_aaaa1111', ['pg1']]]);
});

test('listTemplates answers summaries without the block payloads', async () => {
    const res = await call(handlers.listTemplates, {});
    assert.deepStrictEqual(res.body, {
        templates: [
            { id: 't1', name: 'Hero', description: '', createdAt: '2026-01-01', blockCount: 2 },
            { id: 't2', name: 'Empty', description: 'none', createdAt: '2026-01-02', blockCount: 0 },
        ],
    });
});

test('postPageAiTranslate: unknown page is a 404, the default locale a 400', async () => {
    const missing = await call(handlers.postPageAiTranslate, { params: { id: 'nope', locale: 'de' } });
    assert.strictEqual(missing.statusCode, 404);
    const deflt = await call(handlers.postPageAiTranslate, { params: { id: 'pg1', locale: 'EN' } });
    assert.strictEqual(deflt.statusCode, 400);
    assert.deepStrictEqual(calls, []);
});

test('postPageAiTranslate translates with the language name and persists the override', async () => {
    const res = await call(handlers.postPageAiTranslate, { params: { id: 'pg1', locale: 'DE' } });
    assert.strictEqual(res.body.message, 'Translated 2 fields');
    const [, args] = calls.find(([name]) => name === 'aiTranslatePage');
    assert.strictEqual(args.languageName, 'Deutsch');
    assert.strictEqual(args.locale, 'de');
    assert.deepStrictEqual(calls.at(-1).slice(0, 5), ['saveTranslatedPageOverride', 'pj_aaaa1111', 'pg1', 'de', { blocks: {} }]);
});

test('deletePageHandler answers 404 for an unknown page and reports the outcome for a real one', async () => {
    const missing = await call(handlers.deletePageHandler, { params: { id: 'pg_nope' } });
    assert.strictEqual(missing.statusCode, 404);
    const ok = await call(handlers.deletePageHandler, { params: { id: 'pg1' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.neutralisedLinks, 3);
});
