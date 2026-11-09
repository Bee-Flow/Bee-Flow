/**
 * POST /create-app-password files the minted app password under the person's
 * Nextcloud uid (auth/admin/appPasswordRoutes.js).
 *
 * The stored username is what WebDAV paths and Basic auth are built from
 * (/remote.php/dav/files/<uid>/). The route used `session.user.id`, which
 * after an OAuth sign-in is the Bee Flow account id (or the `nextcloud-<uid>`
 * SSO id), never the raw uid — so every later file call went to a user that
 * does not exist. The raw uid is kept on the session as `nextcloudUid`.
 *
 * Run: cd server && node --test auth/admin/appPasswordRoutes.createUid.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/** @type {{ userId: string, username: string }[]} */
const stored = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../permissions': { requireAuth: pass, loadConfig: async () => ({ oauth: { nextcloudUrl: 'https://nc.example.test' } }) },
    '../../stores/userStore': {
        getAppPassword: async () => null,
        storeAppPassword: async (userId, username) => { stored.push({ userId, username }); return true; },
        deleteAppPassword: async () => {},
    },
    '../../integrations/nextcloudTarget': {
        MAX_URL_LENGTH: 2048,
        assertAllowedNextcloudHost: () => {},
        nextcloudFetch: async () => ({ ok: true, status: 200, json: async () => ({ ocs: { data: { apppassword: 'app-pw' } } }) }),
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:app-password-create-uid:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]appPasswordRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./appPasswordRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../testUtils/routeHarness');

test.beforeEach(() => { stored.length = 0; });

test('the app password is stored under the raw Nextcloud uid, not the Bee Flow account id', async () => {
    const dispatch = dispatcher(router, {
        session: () => ({ user: { id: 'nextcloud-alice', 'display-name': 'Alice A.' }, nextcloudUid: 'alice', oauthProvider: 'nextcloud', accessToken: 'tok' }),
    });
    const res = await dispatch({ method: 'POST', url: '/create-app-password', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(stored, [{ userId: 'nextcloud-alice', username: 'alice' }]);
});

test('a session from before the uid was kept still falls back to the account id', async () => {
    const dispatch = dispatcher(router, {
        session: () => ({ user: { id: 'alice' }, oauthProvider: 'nextcloud', accessToken: 'tok' }),
    });
    const res = await dispatch({ method: 'POST', url: '/create-app-password', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(stored, [{ userId: 'alice', username: 'alice' }]);
});
