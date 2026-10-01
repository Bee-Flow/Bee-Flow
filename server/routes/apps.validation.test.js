/**
 * What the App Marketplace routes accept, and what they say when they refuse
 * (routes/apps.js).
 *
 * The audience fields failed WIDE:
 *
 *   - `sharedGroups: 'sales'` (one group, not a list) was stored as `[]` —
 *     the whole organisation — under `{ success: true }`;
 *   - POST ignored `isPublished`, so a draft was live for the whole
 *     organisation the moment it was created.
 *
 * And PUT passed every other field straight to the UPDATE: a PUT without
 * `description` wiped it, one without `name` (just `{ isPublished: false }`)
 * was a 500 on the NOT NULL column.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.sharedGroups`), in a sentence;
 *   - the store is never reached, so a refused request changes nothing;
 *   - PUT keeps what the body leaves out.
 *
 * Run: cd server && node --test routes/apps.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const EXISTING = {
    id: 'app1', name: 'Quote tool', description: 'Makes quotes', code: '<p>hi</p>', thumbnail: 'data:image/png;base64,AAAA',
    created_by: 'u1', organization_id: 'org1', is_published: true, shared_groups: '["g1"]',
};

const MOCKS = {
    '../stores/appStore': {
        getApp: async (id) => (id === 'app1' ? { ...EXISTING } : null),
        createApp: async (...a) => { touched.push({ what: 'createApp', args: a }); return { id: 'new' }; },
        updateApp: async (...a) => { touched.push({ what: 'updateApp', args: a }); return true; },
        deleteApp: async () => true,
        getPublishedAppsForUser: async () => [],
        getAppsByUser: async () => [],
    },
    '../stores/userStore': { getUser: async () => ({ organizationId: 'org1' }) },
    '../auth': {
        resolveUserOrgIds: async () => new Set(['org1']),
        canSeePublished: () => true,
        resolveUserGroups: async () => [],
    },
    '../auth/permissions': { requireAuth: (req, res, next) => next() },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:apps-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]apps\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./apps');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'u1', username: 'jan' } }) });

test.beforeEach(() => { touched.length = 0; });

test('one group as text is refused, instead of sharing the app with the whole organisation', async () => {
    for (const [method, url] of [['POST', '/'], ['PUT', '/app1']]) {
        const res = await dispatch({ method, url, body: { name: 'Quote tool', code: '<p>hi</p>', sharedGroups: 'sales' } });
        assert.strictEqual(res.statusCode, 400, `${method} ${url}`);
        assert.strictEqual(res.body.error, 'sharedGroups is a list of group ids — an empty list shares with the whole organisation.');
        assert.ok(res.body.details.some((d) => d.path === 'body.sharedGroups'));
    }
    assert.deepStrictEqual(touched, []);
});

test('null is refused too: widening an audience takes the explicit empty list', async () => {
    const res = await dispatch({ method: 'PUT', url: '/app1', body: { sharedGroups: null } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a draft created with isPublished: false stays a draft', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'Draft', code: '<p/>', isPublished: false, sharedGroups: ['g1'] } });
    assert.strictEqual(res.statusCode, 201);
    const args = touched[0].args;
    assert.strictEqual(args[6], false, 'isPublished reaches the store');
    assert.deepStrictEqual(args[8], ['g1']);
});

test('a create without a name or code is refused in words', async () => {
    let res = await dispatch({ method: 'POST', url: '/', body: { code: '<p/>' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'An app needs a name.');
    res = await dispatch({ method: 'POST', url: '/', body: { name: 'X', code: 42 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'An app needs its code, as text.');
    assert.deepStrictEqual(touched, []);
});

test('a PUT keeps what it leaves out — no wiped description, no NOT NULL 500', async () => {
    const res = await dispatch({ method: 'PUT', url: '/app1', body: { isPublished: false } });
    assert.strictEqual(res.statusCode, 200);
    const [id, name, description, code, thumbnail, isPublished, sharedGroups] = touched[0].args;
    assert.deepStrictEqual(
        { id, name, description, code, thumbnail, isPublished, sharedGroups },
        { id: 'app1', name: 'Quote tool', description: 'Makes quotes', code: '<p>hi</p>', thumbnail: EXISTING.thumbnail, isPublished: false, sharedGroups: undefined },
    );
});

test('a PUT can still clear the description and the thumbnail, and change the audience', async () => {
    const res = await dispatch({ method: 'PUT', url: '/app1', body: { description: '', thumbnail: null, sharedGroups: [] } });
    assert.strictEqual(res.statusCode, 200);
    const [, , description, , thumbnail, , sharedGroups] = touched[0].args;
    assert.strictEqual(description, '');
    assert.strictEqual(thumbnail, null);
    assert.deepStrictEqual(sharedGroups, []);
});

test('isPublished as text is refused', async () => {
    const res = await dispatch({ method: 'PUT', url: '/app1', body: { isPublished: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'isPublished is true or false.');
    assert.deepStrictEqual(touched, []);
});
