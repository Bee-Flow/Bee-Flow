/**
 * POST /ai/twoba/test (routes/ai/config/twobaTestRoute.mts): tries the form's
 * unsaved values, falls back to the stored secret and password only for the
 * stored client id and user name, refuses a malformed value before trying, and
 * answers the 2BA company and OCS database. Also the 2BA fields of POST
 * /ai/user-settings (usecases/ai/config/twobaFields.mts).
 *
 * Run: cd server && node --test routes/ai/config/integrations.twobaTest.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../../testUtils/routeHarness');
const { createTwobaTestRouter, SECRET_NEEDED, PASSWORD_NEEDED, CONNECT_FAILED } = require('./twobaTestRoute.mts');
const { twobaFields } = require('../../../usecases/ai/config/twobaFields.mts');

const OK = Object.freeze({ ok: true, companyName: 'Example Company BV', databaseName: 'Main' });
/** Per case: the stored secrets, what the route tried, and what the (fake) 2BA answers or throws. */
const stored = new Map();
const attempts = [];
const fake = { outcome: OK };

const api = h.serve('/ai', createTwobaTestRouter({
    requireAuth: (_req, _res, next) => next(),
    getSecret: async (k) => stored.get(k) ?? null,
    testConnection: async (userId, cfg) => {
        attempts.push({ userId, ...cfg });
        return fake.outcome instanceof Error ? Promise.reject(fake.outcome) : fake.outcome;
    },
}));
test.after(api.close);
test.beforeEach(() => { stored.clear(); attempts.splice(0); fake.outcome = OK; });

const call = (body, opts = {}) => api.call('POST', '/ai/twoba/test', { body, ...opts });

function storeConnection(mode = 'password') {
    for (const [k, v] of Object.entries({ client_id: 'client-1', client_secret: 'stored-secret', auth_mode: mode, username: 'buyer', password: 'stored pw' })) stored.set(`twoba_${k}_user_u1`, v);
}

test('no session: 401', async () => {
    assert.equal((await call({}, { user: null })).status, 401);
});

test('stored connection: tried as stored, answers company and OCS database', async () => {
    storeConnection();
    const res = await call({});
    assert.deepEqual(res.body, { ok: true, companyName: 'Example Company BV', databaseName: 'Main' });
    assert.deepEqual(attempts, [{ userId: 'u1', clientId: 'client-1', clientSecret: 'stored-secret', mode: 'password', username: 'buyer', password: 'stored pw' }]);
});

test('a different client id or user name is not tried with the stored secret or password', async () => {
    storeConnection();
    assert.deepEqual((await call({ twobaClientId: 'client-2' })).body, { ok: false, error: SECRET_NEEDED });
    assert.deepEqual((await call({ twobaUsername: 'someone' })).body, { ok: false, error: PASSWORD_NEEDED });
    assert.equal(attempts.length, 0);
    await call({ twobaClientId: 'client-2', twobaClientSecret: 's2', twobaUsername: 'someone', twobaPassword: ' p w ' });
    assert.deepEqual(attempts[0], { userId: 'u1', clientId: 'client-2', clientSecret: 's2', mode: 'password', username: 'someone', password: ' p w ' });
});

test('"Sign in with 2BA": the stored client and sign-in are tried', async () => {
    storeConnection('authorization_code');
    await call({});
    assert.deepEqual(attempts, [{ userId: 'u1', clientId: 'client-1', clientSecret: 'stored-secret', mode: 'authorization_code', username: '', password: '' }]);
});

test('malformed values are refused by the schema before any attempt', async () => {
    for (const body of [{ twobaClientId: 'has space' }, { twobaClientSecret: 'a\tb' }, { twobaAuthMode: 'magic' }, { twobaUsername: 'a\nb' }, { other: 1 }]) {
        assert.equal((await call(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(attempts.length, 0);
});

test('a failed test answers its sentence; a thrown one the generic sentence', async () => {
    storeConnection();
    fake.outcome = { ok: false, error: '2BA refused the user name or password.' };
    assert.deepEqual((await call({})).body, { ok: false, error: '2BA refused the user name or password.' });
    fake.outcome = new Error('boom stored-secret');
    assert.deepEqual((await call({})).body, { ok: false, error: CONNECT_FAILED });
});

test('user-settings fields: empty clears, shapes are checked, a password keeps its spaces', () => {
    const parse = (field, value) => twobaFields[field].safeParse(value);
    assert.equal(parse('twobaClientId', '').success, true);
    assert.equal(parse('twobaClientId', null).success, true);
    assert.equal(parse('twobaClientId', ' abc ').data, 'abc');
    assert.equal(parse('twobaClientId', 'a b').success, false);
    assert.equal(parse('twobaAuthMode', 'authorization_code').success, true);
    assert.equal(parse('twobaAuthMode', 'client_credentials').success, false);
    assert.equal(parse('twobaUsername', 'buyer@example').success, true);
    assert.equal(parse('twobaPassword', ' with spaces ').data, ' with spaces ');
    assert.equal(parse('twobaPassword', 'x'.repeat(257)).success, false);
});
