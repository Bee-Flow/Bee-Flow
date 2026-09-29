/**
 * What the CMS builder accepts (routes/ai/cmsBuilder.js).
 *
 * The turn body was destructured by hand: a misspelled `modelTeir` ran the
 * turn on `auto`, a misspelled `contxt` dropped the editor's focus, and a
 * number as `message` was stringified and sent to the model — each under a
 * 200 and a paid turn. What this file pins:
 *
 *   - an unknown key is a 400 that names it and lists the keys the turn takes;
 *   - the two hand-written refusals keep their words (`Message required`,
 *     `Valid siteId required`, `Invalid siteId format`);
 *   - a refused request reads nothing: no site, no session, no tier;
 *   - the admin gate still answers first.
 *
 * Run: cd server && node --test routes/ai/cmsBuilder.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

const db = h.recordDb();
const api = h.serve('/api/cms/builder', require('./cmsBuilder'), { session: { isAdmin: true } });
test.before(() => db.settle());
test.after(api.close);
test.beforeEach(() => db.reset());

const stream = (body, user) => api.call('POST', '/api/cms/builder/stream', { body, user });
const SITE = 'pj_abcd1234';

test('a misspelled key is refused by name, with the keys a turn takes', async () => {
    const res = await stream({ message: 'Add a hero', siteId: SITE, modelTeir: 'pro' });
    h.assertRefused(assert, res, 'body', /"modelTeir"/);
    assert.match(res.body.error, /It takes: message, siteId, builderSessionId, modelTier, timezone, context/);
    assert.deepStrictEqual(db.queries, []);
});

test('the hand-written refusals keep their words', async () => {
    h.assertRefused(assert, await stream({ siteId: SITE }), 'body.message', /^Message required$/);
    h.assertRefused(assert, await stream({ message: '   ', siteId: SITE }), 'body.message', /^Message required$/);
    h.assertRefused(assert, await stream({ message: 42, siteId: SITE }), 'body.message', /^Message required$/);
    h.assertRefused(assert, await stream({ message: 'x' }), 'body.siteId', /^Valid siteId required$/);
    h.assertRefused(assert, await stream({ message: 'x', siteId: 'nope' }), 'body.siteId', /^Valid siteId required$/);
    h.assertRefused(assert, await api.call('GET', '/api/cms/builder/session/nope'), 'params.siteId', /^Invalid siteId format$/);
    assert.deepStrictEqual(db.queries, []);
});

test('context is an object and the tier a name', async () => {
    h.assertRefused(assert, await stream({ message: 'x', siteId: SITE, context: 'hero' }), 'body.context', /editor's focus/);
    h.assertRefused(assert, await stream({ message: 'x', siteId: SITE, modelTier: 3 }), 'body.modelTier', /name of a model tier/);
    assert.deepStrictEqual(db.queries, []);
});

test('the admin gate answers before the body', async () => {
    const res = await stream({ nope: true }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid turn passes the schema and looks the site up', async () => {
    const res = await stream({ message: 'Add a hero', siteId: SITE, modelTier: 'auto', context: { activePageId: 'p1' }, timezone: 'Europe/Amsterdam' });
    // No site in an empty database: the handler's own 404, reached after the schema.
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.length > 0, 'a valid turn reads the site');
});
