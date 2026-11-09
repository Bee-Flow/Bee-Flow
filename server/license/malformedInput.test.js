/**
 * Licence input that is valid JSON but not an object.
 *
 * A pasted token, an admin blob and the licence server's refresh answer are all
 * JSON somebody else wrote. `null`, `7` or `"x"` parse without an error, and
 * each reader then went on to read a field of it: a TypeError, so a 500 on
 * POST /api/license/activate instead of the 400 a bad key gets, and a refresh
 * that never recorded its failure.
 *
 * Run: node --test license/malformedInput.test.js
 */

const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.LICENSE_REFRESH_URL = 'https://license.invalid/v1/refresh';

const calls = { failures: [], revoked: [], successes: [], upserts: [] };
const fakeStore = {
    async getActiveLicenseForServer() { return null; },
    async getActiveLicenseForOrg() { return null; },
    async getActiveLicenseForUser() { return null; },
    async getActiveLicensesForOrgs() { return []; },
    async upsertLicense(args) { calls.upserts.push(args); return { id: args.licenseId, ...args }; },
    async markRefreshFailure(id, opts) { calls.failures.push({ id, ...opts }); },
    async markRefreshSuccess(id) { calls.successes.push(id); },
    async markRevoked(id) { calls.revoked.push(id); },
    async logLicenseAudit() {},
};

// The licence module and the refresher call the store as `store.fn(...)`, so
// the stand-ins go on the store object they share; no statement of this file
// reaches a database.
require('../testUtils/routeHarness').recordDb();
const store = require('./store');
const realStore = Object.fromEntries(Object.keys(fakeStore).map((name) => [name, store[name]]));
Object.assign(store, fakeStore);
after(() => Object.assign(store, realStore));

const license = require('./index');
const verify = require('./verify');
const refresh = require('./refresh');

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    for (const list of Object.values(calls)) list.length = 0;
});

test('verifyToken answers decode_failed for a header or payload that is not an object', async () => {
    for (const [header, payload] of [[null, {}], [7, {}], [{ alg: 'RS256' }, null], ['x', 'y']]) {
        const result = await verify.verifyToken(`${b64url(header)}.${b64url(payload)}.c2ln`);
        assert.equal(result.valid, false);
        assert.match(result.error, /^decode_failed/);
    }
});

test('activateLicense refuses a token whose header is JSON null with a coded error', async () => {
    await assert.rejects(
        license.activateLicense({ token: `${b64url(null)}.${b64url({})}.c2ln`, organizationId: 'org-1' }),
        (err) => typeof err.code === 'string' && err.code.startsWith('decode_failed'),
    );
    assert.equal(calls.upserts.length, 0);
});

test('activateLicense refuses an admin blob that decodes to a non-object with malformed_admin_blob', async () => {
    for (const value of [null, 7, 'text', [1, 2]]) {
        await assert.rejects(
            license.activateLicense({ token: `${license.adminIssuance.BLOB_PREFIX}${b64url(value)}`, organizationId: 'org-1' }),
            (err) => err.code === 'malformed_admin_blob',
        );
    }
    assert.equal(calls.upserts.length, 0);
});

test('refreshOne records a failure when the licence server answers JSON that is not an object', async () => {
    for (const text of ['null', '7', '"active"']) {
        globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, text: async () => text }));
        const result = await refresh.refreshOne({ id: 'lic-1', billingInterval: 'monthly' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'malformed_response');
    }
    assert.deepEqual(calls.failures.map((f) => f.id), ['lic-1', 'lic-1', 'lic-1']);
    assert.equal(calls.revoked.length + calls.successes.length, 0);
});
