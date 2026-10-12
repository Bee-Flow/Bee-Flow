/**
 * What the instance-wide signup policy accepts, and what it says when it
 * refuses (auth/login/signupPolicyRoutes.js).
 *
 * Every setting on this route was written only when it already had the right
 * type or value — `if (typeof x === 'boolean')`, `if (GEO_MODES.includes(x))`,
 * `geoCountries.filter(...)` — and everything else was DISCARDED under a 200.
 * So the console reported "Signup settings saved." while:
 *
 *   - `geoMode: 'blocklst'` left geo-blocking switched off;
 *   - `allowOrgSignups: "false"` left organisation signups open;
 *   - `geoCountries: ['NLD','BE']` dropped NL — in allowlist mode that locks
 *     out the very country the admin was admitting;
 *   - `consumerLoginMethods: ['password','gogle']` silently saved password only.
 *
 * What this file pins is the part an administrator can act on:
 *
 *   - the 400 NAMES the field (`body.geoMode`), not just "invalid request";
 *   - the message is a sentence;
 *   - configStore is never written, so a refused save changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/signupPolicyRoutes.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/userStore': {
        getAllUsers: async () => [],
        updateUser: async () => true,
        deleteUser: async () => true,
        logAccessAudit: async () => {},
    },
    '../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); },
    },
    '../permissions': { requireSuperAdmin: pass },
    '../signupGuards': { getSignupAccessConfig: async () => ({}) },
    './signupIntakeRoutes': { isOrgDirectoryPublic: async () => false },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:signup-policy-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]signupPolicyRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./signupPolicyRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing written. */
async function refuses(body, field) {
    const res = await dispatch({ method: 'PUT', url: '/admin/signup-settings', body });
    const what = JSON.stringify(body);
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused save must not reach configStore');
}

test('a misspelled geo mode is refused instead of leaving geo-blocking off', async () => {
    await refuses({ geoMode: 'blocklst' }, 'body.geoMode');
});

test('a toggle sent as a string is refused instead of being dropped', async () => {
    await refuses({ allowOrgSignups: 'false' }, 'body.allowOrgSignups');
});

test('a three-letter country is refused instead of vanishing from the list', async () => {
    // ['NLD','BE'] used to save as ['BE'] — in allowlist mode that locks out
    // every Dutch visitor the admin had just admitted.
    await refuses({ geoMode: 'allowlist', geoCountries: ['NLD', 'BE'] }, 'body.geoCountries.0');
});

test('an unknown consumer login method is refused instead of silently removed', async () => {
    await refuses({ consumerLoginMethods: ['password', 'gogle'] }, 'body.consumerLoginMethods.1');
});

test('a misspelled setting is refused rather than answered "saved"', async () => {
    await refuses({ waitlistEnable: true }, 'body');
});

test('the refusal is a sentence, not the bare word "Required"', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/signup-settings', body: { geoMode: 'blocklst' } });
    assert.strictEqual(res.body.error, 'geoMode is one of off, allowlist, blocklist.');
});

test('a well-formed save still writes every setting it names', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/admin/signup-settings',
        body: {
            allowOrgSignups: false, allowConsumerSignups: true, waitlistEnabled: true,
            emailVerificationEnabled: true, requireMfaForPasswordAccounts: false,
            consumerLoginMethods: ['password', 'google'],
            orgDirectoryPublic: true, connectorOnly: false,
            geoMode: 'allowlist', geoCountries: ['nl', ' be '],
            geoBlockUnknown: true, geoApplyConnector: false,
        },
    });
    assert.strictEqual(res.statusCode, 200);
    const written = Object.fromEntries(touched.filter((t) => t.what === 'setConfig').map((t) => t.args));
    assert.strictEqual(written.signup_org_enabled, false);
    assert.strictEqual(written.signup_geo_mode, 'allowlist');
    // Trimmed and upper-cased once, by the schema, on the way to the store.
    assert.deepStrictEqual(written.signup_geo_countries, ['NL', 'BE']);
    assert.deepStrictEqual(written.consumer_login_methods, ['password', 'google']);
});

test('an empty body is still a valid no-op save', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/signup-settings', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.filter((t) => t.what === 'setConfig'), []);
});
