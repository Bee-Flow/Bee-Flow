/**
 * What the CMS admin routes accept (routes/cms.js, routes/cmsAnalytics.js).
 *
 *   - `hideHeader: "false"` / `noAnalytics: "true"` on the page settings were
 *     ignored under a 200 (the store only takes real booleans), so a page an
 *     admin had taken out of analytics was still tracked.
 *   - on the analytics settings, the text "true" read as false:
 *     `enabled: "true"` switched tracking OFF and `tracker.doNotTrack: "true"`
 *     stopped honouring Do Not Track.
 *   - a misspelled key (`noAnalyitcs`) was ignored under a 200.
 *
 * A refused request writes nothing. The site is resolved first (that is a
 * read), as it always was; the schema runs after it.
 *
 * Run: cd server && node --test routes/cms.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { projectKey } = require('../stores/cms/shared');

const SITE = 'pj_abcd1234';
const site = { version: 99, name: 'Site', pages: [{ id: 'pg1', slug: 'home', title: 'Home' }], header: { nav: [] } };
const ADMIN = { ...h.USER, role: 'admin' };
const { db, api } = h.routeUnderTest(test, '/api/cms', () => require('./cms'), {
    user: ADMIN,
    answer: (sql, params) => (/SELECT value FROM config WHERE key/i.test(sql) && params?.[0] === projectKey(SITE)
        ? { rows: [{ value: site }] } : undefined),
});

const writes = () => db.queries.filter((q) => !/^\s*SELECT/i.test(q));
const meta = (body, user) => api.call('PUT', `/api/cms/sites/${SITE}/pages/pg1/meta`, { body, user });

test('page settings take booleans, and only the keys the store reads', async () => {
    h.assertRefused(assert, await meta({ noAnalytics: 'true' }), 'body.noAnalytics', /noAnalytics is true or false/);
    h.assertRefused(assert, await meta({ hideHeader: 'false' }), 'body.hideHeader', /hideHeader is true or false/);
    h.assertRefused(assert, await meta({ noAnalyitcs: true }), 'body', /"noAnalyitcs"/);
    assert.deepStrictEqual(writes(), []);
});

test('the document envelopes are named and closed', async () => {
    const call = (method, path, body) => api.call(method, `/api/cms/sites/${SITE}${path}`, { body });
    h.assertRefused(assert, await call('PUT', '', { siteDoc: {} }), 'body.site', /site object required/);
    h.assertRefused(assert, await call('PUT', '/pages/pg1', { page: 'x' }), 'body.page', /page object required/);
    h.assertRefused(assert, await call('PUT', '/pages/order', { orderedIds: 'pg1' }), 'body.orderedIds', /orderedIds array required/);
    h.assertRefused(assert, await call('PUT', '/live', { live: 'true' }), 'body.live', /live must be a boolean/);
    h.assertRefused(assert, await call('PATCH', '', { name: 'x', title: 'x' }), 'body', /"title"/);
    assert.deepStrictEqual(writes(), []);
});

test('analytics settings take booleans as booleans', async () => {
    const put = (body) => api.call('PUT', '/api/cms/admin/analytics/settings', { body });
    h.assertRefused(assert, await put({ enabled: 'true' }), 'body.enabled', /enabled is true or false/);
    h.assertRefused(assert, await put({ tracker: { doNotTrack: 'true' } }), 'body.tracker.doNotTrack', /doNotTrack is true or false/);
    h.assertRefused(assert, await put({ recorder: { sampleRate: 5 } }), 'body.recorder.sampleRate', /above 0, at most 1/);
    h.assertRefused(assert, await put({ consentMode: 'cookie' }), 'body.consentMode', /cookieless or cookies/);
    const rec = await api.call('PUT', '/api/cms/admin/analytics/recorder', { body: { siteId: SITE, enabled: 'true' } });
    h.assertRefused(assert, rec, 'body.enabled', /enabled is true or false/);
    assert.deepStrictEqual(writes(), []);
});

test('the session is checked before the body', async () => {
    const res = await meta({ noAnalytics: 'true' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('valid page settings reach the store and answer as before', async () => {
    const res = await meta({ noAnalytics: true });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.page.noAnalytics, true);
    assert.ok(writes().length > 0, 'the page settings were saved');
});
