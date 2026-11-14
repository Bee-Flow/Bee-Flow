/**
 * POST /ai/frappe-crm/test (routes/ai/config/frappeCrmTestRoute.mts): tries the
 * form's unsaved values, falls back to the stored secrets only for the stored
 * site and key, refuses a malformed value before trying, and never echoes the
 * secret. Also the Frappe CRM fields of POST /ai/user-settings.
 *
 * Run: cd server && node --test routes/ai/config/integrations.frappeCrmTest.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../../testUtils/routeHarness');
const { createFrappeCrmTestRouter, SECRET_NEEDED, NOT_CONFIGURED, CONNECT_FAILED } = require('./frappeCrmTestRoute.mts');
const { frappeCrmFields } = require('../../../usecases/ai/config/frappeCrmFields.mts');

const SECRET = 'storedSecretValue99';
const stored = {};
const attempts = [];
let outcome = { ok: true, user: 'api@example.com' };

const api = h.serve('/ai', createFrappeCrmTestRouter({
    requireAuth: (_req, _res, next) => next(),
    getSecret: async (k) => stored[k] || null,
    testConnection: async (creds) => {
        attempts.push(creds);
        if (outcome instanceof Error) throw outcome;
        return outcome;
    },
}));
test.after(api.close);

test.beforeEach(() => {
    for (const k of Object.keys(stored)) delete stored[k];
    attempts.length = 0;
    outcome = { ok: true, user: 'api@example.com' };
});

const call = (body, opts = {}) => api.call('POST', '/ai/frappe-crm/test', { body, ...opts });

function storeConnection() {
    stored.frappe_crm_url_user_u1 = 'https://crm.example.com';
    stored.frappe_crm_api_key_user_u1 = 'storedkey';
    stored.frappe_crm_api_secret_user_u1 = SECRET;
}

test('no session: 401', async () => {
    const res = await call({}, { user: null });
    assert.equal(res.status, 401);
});

test('stored connection: tried as stored, answers the Frappe user', async () => {
    storeConnection();
    const res = await call({});
    assert.deepEqual(res.body, { ok: true, user: 'api@example.com' });
    assert.deepEqual(attempts, [{ url: 'https://crm.example.com', apiKey: 'storedkey', apiSecret: SECRET }]);
});

test('nothing stored and nothing typed: the not-connected sentence, no attempt', async () => {
    const res = await call({});
    assert.deepEqual(res.body, { ok: false, error: NOT_CONFIGURED });
    assert.equal(attempts.length, 0);
});

test('a different site or key without its secret is not tried with the stored secret', async () => {
    storeConnection();
    for (const body of [{ frappeCrmUrl: 'https://other.example.com' }, { frappeCrmApiKey: 'otherkey' }]) {
        const res = await call(body);
        assert.deepEqual(res.body, { ok: false, error: SECRET_NEEDED });
    }
    assert.equal(attempts.length, 0);
});

test('typed values with their secret are tried as typed', async () => {
    storeConnection();
    await call({ frappeCrmUrl: 'https://other.example.com', frappeCrmApiKey: 'k2', frappeCrmApiSecret: 's2' });
    assert.deepEqual(attempts, [{ url: 'https://other.example.com', apiKey: 'k2', apiSecret: 's2' }]);
});

test('malformed values are refused by the schema before any attempt', async () => {
    for (const body of [{ frappeCrmUrl: 'ftp://x' }, { frappeCrmUrl: 'http://10.0.0.1' }, { frappeCrmApiKey: 'a:b' }, { frappeCrmApiSecret: 'has space' }, { other: 1 }]) {
        const res = await call(body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(attempts.length, 0);
});

test('a failed test never echoes the secret; a thrown one answers the generic sentence', async () => {
    storeConnection();
    outcome = { ok: false, error: `Frappe CRM: refused ${SECRET}` };
    const res = await call({});
    assert.equal(res.body.ok, false);
    assert.ok(!res.body.error.includes(SECRET));
    outcome = new Error(`boom ${SECRET}`);
    assert.deepEqual((await call({})).body, { ok: false, error: CONNECT_FAILED });
});

test('user-settings fields: empty clears, a valid connection passes, a private address in cloud mode does not', () => {
    const parse = (field, value) => frappeCrmFields[field].safeParse(value);
    assert.equal(parse('frappeCrmUrl', '').success, true);
    assert.equal(parse('frappeCrmUrl', null).success, true);
    assert.equal(parse('frappeCrmUrl', ' https://crm.example.com ').data, 'https://crm.example.com');
    const priv = parse('frappeCrmUrl', 'http://192.168.0.2');
    assert.equal(priv.success, false);
    assert.match(priv.error.issues[0].message, /FRAPPE_CRM_ALLOW_PRIVATE_HOSTS/);
    assert.equal(parse('frappeCrmApiKey', 'abc123').success, true);
    assert.equal(parse('frappeCrmApiKey', 'abc:123').success, false);
    assert.equal(parse('frappeCrmApiSecret', 'abc:123').success, true);
    assert.equal(parse('frappeCrmApiSecret', 'abc\n123').success, false);
});

test('INTEGRATION_TEST_MAX_PER_MINUTE: a user past the limit gets 429 without an attempt; 0 is unlimited', async () => {
    const { integrationTestLimiter } = require('../../../usecases/ai/config/integrationTestLimit.mts');
    const deps = { requireAuth: (_req, _res, next) => next(), getSecret: async () => null, testConnection: async () => outcome };
    process.env.INTEGRATION_TEST_MAX_PER_MINUTE = '2';
    const limited = h.serve('/ai', createFrappeCrmTestRouter({ ...deps, rateLimit: integrationTestLimiter('frappe-crm-test-limit') }));
    process.env.INTEGRATION_TEST_MAX_PER_MINUTE = '0';
    const open = h.serve('/ai', createFrappeCrmTestRouter({ ...deps, rateLimit: integrationTestLimiter('frappe-crm-test-open') }));
    delete process.env.INTEGRATION_TEST_MAX_PER_MINUTE;
    try {
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await limited.call('POST', '/ai/frappe-crm/test', { body: {} })).status);
        assert.deepEqual(statuses, [200, 200, 429]);
        const other = await limited.call('POST', '/ai/frappe-crm/test', { body: {}, user: { id: 'u2' } });
        assert.equal(other.status, 200, 'the limit is per user');
        for (let i = 0; i < 5; i++) assert.equal((await open.call('POST', '/ai/frappe-crm/test', { body: {} })).status, 200);
    } finally {
        await limited.close();
        await open.close();
    }
});
