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
 * The blog routes (routes/cmsBlog.js, mounted by routes/cms.js) follow the
 * same rule: closed envelopes, typed and capped fields, post ids checked
 * before any read, and the public read answers an empty list when no site
 * is live.
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

// ── blog posts ──────────────────────────────────────────────────────

const posts = (method, path, body, user) => api.call(method, `/api/cms/sites/${SITE}/posts${path}`, { body, user });

test('creating a post: title required, fields typed and capped, unknown keys named', async () => {
    h.assertRefused(assert, await posts('POST', '', {}), 'body.title', /title is text/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', status: 'live' }), 'body.status', /status is one of draft, scheduled, published/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', tags: 'a,b' }), 'body.tags', /tags is a list/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', tags: Array(11).fill('t') }), 'body.tags', /At most 10 tags/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', body: 'y'.repeat(100_001) }), 'body.body', /at most 100000/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', authorId: 'u1' }), 'body', /"authorId"/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', seo: { noIndex: 'yes' } }), 'body.seo.noIndex', /true or false/);
    h.assertRefused(assert, await posts('POST', '', { title: 'x', seo: { canonical: 'https://x' } }), 'body.seo', /canonical/);
    assert.deepStrictEqual(writes(), []);
});

test('saving a post and a translation: closed envelopes, no writes on refusal', async () => {
    h.assertRefused(assert, await posts('PUT', '/po_abcd1234', { titel: 'x' }), 'body', /"titel"/);
    h.assertRefused(assert, await posts('PUT', '/po_abcd1234/locale/nl', { override: { slug: 'x' } }), 'body.override', /slug/);
    h.assertRefused(assert, await posts('PUT', '/po_abcd1234/locale/nl', { title: 'x' }), 'body.override', /JSON object/);
    assert.deepStrictEqual(writes(), []);
});

test('a malformed post id is a 404 before anything is read or written', async () => {
    const before = db.queries.length;
    const res = await posts('GET', '/not-a-post-id');
    assert.strictEqual(res.status, 404);
    const del = await posts('DELETE', '/..%2F..%2Fsecret');
    assert.strictEqual(del.status, 404);
    assert.ok(!db.queries.slice(before).some(q => /post/i.test(String(q)) && !/SELECT/i.test(q)));
    assert.deepStrictEqual(writes(), []);
});

test('the blog admin routes need a session (the CMS admin gate itself is cms.js requireAdmin)', async () => {
    const anon = await posts('GET', '', undefined, null);
    assert.strictEqual(anon.status, 401);
});

test('public latest posts: an empty list when no site is live, never an error', async () => {
    const res = await api.call('GET', '/api/cms/blog/posts?limit=999&locale=<script>', { user: null });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.posts, []);
});
